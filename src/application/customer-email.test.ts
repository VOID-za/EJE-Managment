import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptJob,
  addLabour,
  captureSignature,
  issueJobCard,
  saveCompletionReport,
  startCompletion,
  startSignature,
} from './job-operations';
import {
  dispatchCustomerEmailsInline,
  expireStuckCustomerEmails,
  listJobEmails,
  queueSignedJobCardEmail,
  retryCustomerEmail,
  signedJobCardKey,
} from './customer-email';
import { deactivateEmailTemplate, listEmailTemplates, saveEmailTemplateVersion } from './email-templates';
import { buildHarness, seedUser, type Harness } from './test-harness';
import type { AppServices, OperationContext } from './context';
import { getJobTypeDefinition, type Job, type JobTypeCode } from '@/domain';

/**
 * INT-EMAIL-3/4: the signed job card goes to the customer on its own, through
 * a durable outbox, exactly once, with the exact signed PDF and the office's
 * template for the job type — and every way that can go wrong is recorded
 * rather than guessed, duplicated or claimed as delivered.
 */

const technician = seedUser('user-tech-sipho');
const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');
const ADDRESS = 'pieter@abc-engineering.example';

const workAndSign = async (harness: Harness, jobNumber = 'EJE-1048'): Promise<Job> => {
  const context = harness.as(technician);
  let job = await acceptJob(context, (await harness.repos.jobs.findByJobNumber(jobNumber))!);
  job = await addLabour(context, job, { date: '2026-09-17', rateType: 'normal', hours: 3, description: 'Spindle drive repair' });
  job = await saveCompletionReport(context, job, { ...job.completionReport, workPerformed: 'Replaced the spindle drive cooling fan.' });
  job = await startCompletion(context, job);
  job = await startSignature(context, job);
  return captureSignature(context, job, { customerName: 'Pieter', customerSurname: 'Nel', strokeData: 'M0,0 L1,1' });
};

/** A context whose email transport fails the way `kind` says, for the given number of attempts. */
const flaky = (context: OperationContext, failures: readonly ({ kind?: string; uncertain?: boolean; message?: string })[]): OperationContext => {
  const queue = [...failures];
  const real = context.services.email;
  const email: AppServices['email'] = {
    sender: 'sales@ejeie.co.za',
    send: (message) => {
      const next = queue.shift();
      if (next === undefined) return real.send(message);
      return Promise.reject(Object.assign(new Error(next.message ?? `failure: ${next.kind}`), next));
    },
    deliveryState: (id) => real.deliveryState(id),
  };
  return { ...context, services: { ...context.services, email } };
};

/** Later, by `minutes`: the background worker's next pass. */
const later = (context: OperationContext, minutes: number): OperationContext => {
  const at = Date.parse(context.services.clock.now()) + minutes * 60_000;
  return { ...context, services: { ...context.services, clock: { now: () => new Date(at).toISOString() as never } } };
};

const sentEmails = (harness: Harness) => harness.outbox.listSync().filter((entry) => entry.channel === 'email');

describe('the signed job card is emailed automatically', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('after the signature is saved and the PDF stored: the template, the values, the exact PDF, from the sending mailbox', async () => {
    const signed = await workAndSign(harness);
    expect(signed.signature).not.toBeNull();
    const issued = await issueJobCard(harness.as(technician), signed, ADDRESS, 'Pieter Nel');

    const [email] = await harness.repos.customerEmails.listForJob(issued.job.id);
    expect(email).toMatchObject({
      state: 'sent',
      recipient: ADDRESS,
      sender: 'sales@ejeie.co.za',
      templateName: 'Signed job card — Breakdown',
      templateVersion: 1,
      attempts: 1,
    });
    expect(email?.subject).toBe('EJE-1048 — Signed Job Card — Breakdown');
    expect(email?.body).toContain('Good day Pieter Nel');
    expect(email?.body).toContain('EJE-1048');
    // The exact final signed PDF, named by key AND checksum — and only that.
    expect(email?.attachment).toEqual({
      storageKey: issued.job.finalDocument!.storageKey,
      fileName: issued.job.finalDocument!.fileName,
      sha256: issued.job.finalDocument!.checksumSha256,
    });
    expect(email?.idempotencyKey).toBe(signedJobCardKey(issued.job, issued.job.finalDocument!.storageKey));

    const sent = sentEmails(harness);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: ADDRESS, subject: email?.subject, body: email?.body, attachments: [issued.job.finalDocument!.fileName] });
    // Accepted, never "delivered" on the provider's say-so.
    expect(issued.delivery.state).toBe('pending_delivery');

    const trail = (await harness.repos.activity.list(issued.job.id)).map((event) => event.type);
    expect(trail).toEqual(expect.arrayContaining(['customer_email_queued', 'customer_email_sent']));
  });

  it.each(['breakdown', 'installation', 'service', 'test_and_repair'] as const)(
    'uses the %s template for a %s job card',
    async (jobType: JobTypeCode) => {
      const signed = await workAndSign(harness);
      const issued = await issueJobCard(harness.as(technician), signed, ADDRESS, 'Pieter Nel');
      // The same issued document under another job type, as a new document.
      const variant = await harness.repos.jobs.save({
        ...issued.job,
        jobType,
        finalDocument: { ...issued.job.finalDocument!, storageKey: `${issued.job.finalDocument!.storageKey}-${jobType}` },
      });
      await harness.services.storage.putDocument({
        ...(await harness.services.storage.getDocument(issued.job.finalDocument!.storageKey))!,
        storageKey: variant.finalDocument!.storageKey,
      });
      const email = await queueSignedJobCardEmail(harness.as(technician), variant, { email: ADDRESS, displayName: 'Pieter Nel' });
      const label = getJobTypeDefinition(jobType).label;
      expect(email.state).toBe('queued');
      expect(email.templateName).toContain(label);
      expect(email.subject).toBe(`EJE-1048 — Signed Job Card — ${label}`);
      expect(email.body).toContain(label.toLowerCase());
    },
  );

  it('sends ONE email when the same signature is issued twice, or the email is queued twice', async () => {
    const signed = await workAndSign(harness);
    const issued = await issueJobCard(harness.as(technician), signed, ADDRESS, 'Pieter Nel');
    await expect(issueJobCard(harness.as(technician), signed, ADDRESS, 'Pieter Nel')).rejects.toThrow(/not ready to be issued/u);
    const again = await queueSignedJobCardEmail(harness.as(technician), issued.job, { email: ADDRESS, displayName: 'Pieter Nel' });
    await dispatchCustomerEmailsInline(harness.as(technician));
    expect(again.state).toBe('sent');
    expect(await harness.repos.customerEmails.listForJob(issued.job.id)).toHaveLength(1);
    expect(sentEmails(harness)).toHaveLength(1);
  });

  it('survives a restart: queued under the API, sent by the next worker pass, and only once', async () => {
    const signed = await workAndSign(harness);
    const deferred: OperationContext = { ...harness.as(technician), deferDelivery: true };
    const issued = await issueJobCard(deferred, signed, ADDRESS, 'Pieter Nel');
    expect(issued.delivery.state).toBe('sending');
    expect(sentEmails(harness)).toHaveLength(0);

    // "Restart": a new context, nothing in memory but the store.
    const worker = harness.as(master);
    expect(await dispatchCustomerEmailsInline(worker)).toBe(1);
    expect(await dispatchCustomerEmailsInline(worker)).toBe(0);
    expect(sentEmails(harness)).toHaveLength(1);
    expect((await harness.repos.jobs.findById(issued.job.id))?.delivery?.state).toBe('pending_delivery');
  });

  it('retries a temporary Microsoft outage with back-off, then sends', async () => {
    const signed = await workAndSign(harness);
    const context = flaky(harness.as(technician), [{ kind: 'provider_unavailable' }]);
    const issued = await issueJobCard(context, signed, ADDRESS, 'Pieter Nel');
    const [waiting] = await harness.repos.customerEmails.listForJob(issued.job.id);
    expect(waiting).toMatchObject({ state: 'queued', attempts: 1, failureKind: 'provider_unavailable' });
    expect(Date.parse(waiting!.nextAttemptAt!)).toBeGreaterThan(Date.parse(waiting!.lastAttemptAt!));
    expect(issued.job.status).toBe('office_handling');

    // Not due yet: nothing happens.
    expect(await dispatchCustomerEmailsInline(harness.as(master))).toBe(0);
    // Due: sent.
    expect(await dispatchCustomerEmailsInline(later(harness.as(master), 2))).toBe(1);
    const [sent] = await harness.repos.customerEmails.listForJob(issued.job.id);
    expect(sent).toMatchObject({ state: 'sent', attempts: 2 });
    expect(sentEmails(harness)).toHaveLength(1);
  });

  it('does NOT retry a permanent failure by itself, and says what must change', async () => {
    const signed = await workAndSign(harness);
    const issued = await issueJobCard(flaky(harness.as(technician), [{ kind: 'credentials_rejected', message: 'Microsoft 365 refused the credentials.' }]), signed, ADDRESS, 'Pieter Nel');
    const [email] = await harness.repos.customerEmails.listForJob(issued.job.id);
    expect(email).toMatchObject({ state: 'failed', nextAttemptAt: null, failureKind: 'credentials_rejected' });
    expect(await dispatchCustomerEmailsInline(later(harness.as(master), 600))).toBe(0);
    const notes = await harness.repos.notifications.list(master.id);
    expect(notes.some((note) => /email failed/u.test(note.title))).toBe(true);
  });

  it('gives up after the last attempt of a temporary failure', async () => {
    const signed = await workAndSign(harness);
    const outage = Array.from({ length: 10 }, () => ({ kind: 'timed_out' }));
    const base = flaky(harness.as(technician), outage);
    const issued = await issueJobCard(base, signed, ADDRESS, 'Pieter Nel');
    let context = base;
    for (let pass = 0; pass < 10; pass += 1) {
      context = later(context, 240);
      await dispatchCustomerEmailsInline(context);
    }
    const [email] = await harness.repos.customerEmails.listForJob(issued.job.id);
    expect(email?.state).toBe('failed');
    expect(email?.attempts).toBe(6);
    expect(email?.failureReason).toMatch(/Gave up after 6 attempts/u);
  });

  it('NEVER re-sends by itself an email that may have gone (a timeout mid-send), and asks the office to check Sent Items', async () => {
    const signed = await workAndSign(harness);
    const issued = await issueJobCard(flaky(harness.as(technician), [{ kind: 'timed_out', uncertain: true }]), signed, ADDRESS, 'Pieter Nel');
    const [email] = await harness.repos.customerEmails.listForJob(issued.job.id);
    expect(email).toMatchObject({ state: 'failed', failureKind: 'uncertain' });
    expect(email?.failureReason).toMatch(/Sent Items/u);
    await expect(retryCustomerEmail(harness.as(master), issued.job)).rejects.toThrow(/Check Sent Items/u);
    const retried = await retryCustomerEmail(harness.as(master), issued.job, { confirmNotSent: true });
    expect(retried.state).toBe('sent');
    expect(retried.retryOf).toBe(email?.id);
  });

  it('marks an email stuck in sending (a crash) as uncertain, and does not send it again', async () => {
    const signed = await workAndSign(harness);
    const issued = await issueJobCard({ ...harness.as(technician), deferDelivery: true }, signed, ADDRESS, 'Pieter Nel');
    const [claimed] = await harness.repos.customerEmails.claimDue(harness.services.clock.now(), 5);
    expect(claimed?.state).toBe('sending');
    // The process dies here. Eleven minutes later:
    expect(await expireStuckCustomerEmails(later(harness.as(master), 11))).toBe(1);
    const [email] = await harness.repos.customerEmails.listForJob(issued.job.id);
    expect(email).toMatchObject({ state: 'failed', failureKind: 'uncertain' });
    expect(sentEmails(harness)).toHaveLength(0);
  });

  it('refuses to send if the stored PDF no longer matches the signed job card it was written for', async () => {
    const signed = await workAndSign(harness);
    const issued = await issueJobCard({ ...harness.as(technician), deferDelivery: true }, signed, ADDRESS, 'Pieter Nel');
    const stored = (await harness.services.storage.getDocument(issued.job.finalDocument!.storageKey))!;
    await harness.services.storage.putDocument({ ...stored, bytes: new Uint8Array([1, 2, 3]), sha256: undefined });
    await dispatchCustomerEmailsInline(harness.as(master));
    const [email] = await harness.repos.customerEmails.listForJob(issued.job.id);
    expect(email).toMatchObject({ state: 'failed', failureKind: 'document_changed' });
    expect(sentEmails(harness)).toHaveLength(0);
  });
});

describe('no recipient, or no template: nothing guessed, nothing sent, the office told', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('an invalid address is not sent, flagged, and the corrected address is used on retry', async () => {
    const signed = await workAndSign(harness);
    const issued = await issueJobCard(harness.as(technician), signed, 'pieter at abc', 'Pieter Nel');
    const [email] = await harness.repos.customerEmails.listForJob(issued.job.id);
    expect(email).toMatchObject({ state: 'attention', failureKind: 'invalid_recipient', recipient: '' });
    expect(sentEmails(harness)).toHaveLength(0);

    const contact = (await harness.repos.customers.findContactById(signed.contactId))!;
    await harness.repos.customers.saveContact({ ...contact, email: ADDRESS });
    const retried = await retryCustomerEmail(harness.as(coordinator), issued.job);
    expect(retried).toMatchObject({ state: 'sent', recipient: ADDRESS, retryOf: email?.id });
    // The flagged email is still in the history exactly as it was.
    const history = await harness.repos.customerEmails.listForJob(issued.job.id);
    expect(history).toHaveLength(2);
    expect(history.find((entry) => entry.id === email?.id)?.state).toBe('attention');
  });

  it('a job type with no active default template is not emailed, and is flagged', async () => {
    const office = harness.as(master);
    const { templates } = await listEmailTemplates(office);
    const breakdown = templates.find((template) => template.jobType === 'breakdown' && template.isDefault)!;
    await deactivateEmailTemplate(office, breakdown.id);

    const signed = await workAndSign(harness);
    const issued = await issueJobCard(harness.as(technician), signed, ADDRESS, 'Pieter Nel');
    const [email] = await harness.repos.customerEmails.listForJob(issued.job.id);
    expect(email).toMatchObject({ state: 'attention', failureKind: 'template_missing', subject: '', body: '' });
    expect(email?.failureReason).toMatch(/no active default email template for Breakdown/u);
    expect(sentEmails(harness)).toHaveLength(0);
    expect((await harness.repos.notifications.list(coordinator.id)).some((note) => /not emailed/u.test(note.title))).toBe(true);
  });
});

describe('the history', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('keeps a sent email exactly as sent, even after the template is edited', async () => {
    const signed = await workAndSign(harness);
    const issued = await issueJobCard(harness.as(technician), signed, ADDRESS, 'Pieter Nel');
    const [before] = await harness.repos.customerEmails.listForJob(issued.job.id);

    const office = harness.as(master);
    const template = (await listEmailTemplates(office)).templates.find((entry) => entry.id === before!.templateId)!;
    await saveEmailTemplateVersion(office, template.id, {
      name: template.name,
      description: template.description,
      subject: 'CHANGED {{job_number}}',
      body: 'CHANGED',
      changeNote: 'test',
      expectedVersion: template.currentVersion,
    });
    // And a store that is asked to change it refuses.
    await harness.repos.customerEmails.recordOutcome(before!.id, { ...before!, state: 'failed', failureReason: 'rewritten' });

    const [after] = await harness.repos.customerEmails.listForJob(issued.job.id);
    expect(after).toEqual(before);
    expect(after?.templateVersion).toBe(1);
  });

  it('is for the office: a technician cannot read it', async () => {
    const signed = await workAndSign(harness);
    const issued = await issueJobCard(harness.as(technician), signed, ADDRESS, 'Pieter Nel');
    expect(await listJobEmails(harness.as(master), issued.job)).toHaveLength(1);
    expect(await listJobEmails(harness.as(coordinator), issued.job)).toHaveLength(1);
    await expect(listJobEmails(harness.as(technician), issued.job)).rejects.toThrow(/Only the office/u);
  });

  it('refuses a retry once an email was sent, and while one is on its way', async () => {
    const signed = await workAndSign(harness);
    const issued = await issueJobCard(harness.as(technician), signed, ADDRESS, 'Pieter Nel');
    await expect(retryCustomerEmail(harness.as(master), issued.job)).rejects.toThrow(/already sent/u);
  });
});
