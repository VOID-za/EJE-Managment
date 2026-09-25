import { beforeEach, describe, expect, it } from 'vitest';
import type { AppNotification, Job } from '@/domain';
import {
  acceptJob,
  addLabour,
  captureSignature,
  issueJobCard,
  recordSignatureRefusal,
  saveCompletionReport,
  startCompletion,
  startSignature,
} from './job-operations';
import { loadJobView } from './job-view';
import { buildHarness, seedUser, type Harness } from './test-harness';

/**
 * WHO THE OFFICE HEARS FROM, AND WHEN. MASTER SCOPE §3.2, §7, §15, §22.
 *
 * §22 records the demo finding this file exists for: a technician finished a
 * job and the Coordinator learned nothing. Tracing it against §15 found two
 * separate problems, and both are asserted here.
 *
 *  1. THE SIGNED HAND-OVER RAISED NOTHING AT ALL. `job_submitted` was a
 *     declared NotificationType with no producer anywhere — the identically
 *     named thing at the issue path is an AUDIT event. §7 makes office review
 *     mandatory, and a review queue nobody is told about is not a workflow.
 *  2. "THE OFFICE" MEANT MASTERS. `notifyOffice` existed and was called from
 *     exactly one place in the codebase.
 *
 * A declared type is not a produced notification. Every case here asserts the
 * producer, the recipients, and that it was persisted against the right people
 * unread — not that a type exists.
 */
const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');
const technician = seedUser('user-tech-sipho');

const inboxOf = async (harness: Harness, userId: string): Promise<readonly AppNotification[]> =>
  harness.repos.notifications.list(userId as never);

const of = (notifications: readonly AppNotification[], type: string, jobId: string) =>
  notifications.filter((entry) => entry.type === type && entry.jobId === jobId);

/** EJE-1048 worked through to the point the customer is asked to sign. */
const workUpToSignature = async (harness: Harness): Promise<Job> => {
  const view = await loadJobView(harness.repos, 'EJE-1048');
  const tech = harness.as(technician);

  let job = await acceptJob(tech, view!.job);
  job = await addLabour(tech, job, {
    date: '2026-09-17',
    rateType: 'normal',
    hours: 2,
    description: 'Spindle drive repair',
  });
  job = await saveCompletionReport(tech, job, {
    ...job.completionReport,
    workPerformed: 'Replaced the spindle drive cooling fan.',
  });
  job = await startCompletion(tech, job);
  return startSignature(tech, job);
};

/*
 * THE SIGNATURE NO LONGER REACHES THE OFFICE. MASTER SCOPE CR-07.
 *
 * This whole block asserted the hand-over: a signature filed a `job_submitted`
 * notification to the Master and the Coordinator, titled "ready for office
 * review" and linked to the review screen, because a MASTER made the final
 * submission. EJE confirmed on 25 September 2026 that the normal signed
 * journey has no office step: the technician checks the signed document and
 * submits it themselves.
 *
 * The cases are not deleted — they are turned round. What the office must NOT
 * be told, and what it IS told instead (once, when the submission actually
 * happens and the customer has been emailed), are both asserted below.
 */
describe('the customer signs — nothing is asked of the office', () => {
  let harness: Harness;
  let job: Job;

  beforeEach(async () => {
    harness = buildHarness();
    const ready = await workUpToSignature(harness);
    job = await captureSignature(harness.as(technician), ready, {
      customerName: 'Pieter',
      customerSurname: 'Nel',
      strokeData: 'M0,0 L1,1',
    });
  });

  it('leaves the job at Review, for its own technician to submit', () => {
    expect(job.status).toBe('review');
  });

  it('does NOT notify the Master — there is nothing for him to do', async () => {
    expect(of(await inboxOf(harness, master.id), 'job_submitted', job.id)).toHaveLength(0);
  });

  it('does NOT notify the Coordinator either', async () => {
    expect(of(await inboxOf(harness, coordinator.id), 'job_submitted', job.id)).toHaveLength(0);
  });

  it('does not notify the technician who just did it', async () => {
    expect(of(await inboxOf(harness, technician.id), 'job_submitted', job.id)).toHaveLength(0);
  });

  it('files nothing at all when a customer signs, to anybody', async () => {
    /*
     * The strong form, so a notification cannot creep back under another type.
     * Counted before and after rather than asserted at zero, because the demo
     * seed already carries notifications against some jobs and this is about
     * what the SIGNATURE adds, which must be nothing.
     *
     * A refusal is the opposite case and is asserted in its own block below —
     * that one DOES reach both office roles, immediately, because a refusal is
     * genuine work for the office.
     */
    const second = buildHarness();
    const ready = await workUpToSignature(second);
    const before = new Map(
      await Promise.all(
        [master, coordinator, technician].map(
          async (person) => [person.id, (await inboxOf(second, person.id)).length] as const,
        ),
      ),
    );

    await captureSignature(second.as(technician), ready, {
      customerName: 'Pieter',
      customerSurname: 'Nel',
      strokeData: 'M0,0 L1,1',
    });

    for (const person of [master, coordinator, technician]) {
      expect((await inboxOf(second, person.id)).length, person.id).toBe(before.get(person.id));
    }
  });
});

describe('the customer refuses — the confirmed refusal decision', () => {
  let harness: Harness;
  let job: Job;

  beforeEach(async () => {
    harness = buildHarness();
    const ready = await workUpToSignature(harness);
    job = await recordSignatureRefusal(harness.as(technician), ready, {
      reason: 'The customer disputes the hours recorded.',
    });
  });

  it('notifies BOTH the Master and the Coordinator', async () => {
    /*
     * The confirmed decision, verbatim: "BOTH MASTER AND COORDINATOR receive
     * an in-app notification". §15 lists the Master; §3.2 puts the Coordinator
     * in the office and the decision settles it.
     */
    expect(of(await inboxOf(harness, master.id), 'signature_refused', job.id)).toHaveLength(1);
    expect(of(await inboxOf(harness, coordinator.id), 'signature_refused', job.id)).toHaveLength(1);
  });

  it('leaves both unread, so the office can see there is something to do', async () => {
    for (const person of [master, coordinator]) {
      const raised = of(await inboxOf(harness, person.id), 'signature_refused', job.id);
      expect(raised[0]?.readAt).toBeNull();
      expect(raised[0]?.handledAt).toBeNull();
    }
  });

  it('does not notify the technician who was turned away', async () => {
    expect(of(await inboxOf(harness, technician.id), 'signature_refused', job.id)).toHaveLength(0);
  });
});

/*
 * THE FINAL SUBMISSION IS THE TECHNICIAN'S. MASTER SCOPE CR-07.
 *
 * This block asserted the opposite, under §3.1/§7/§15, and it was right until
 * 25 September 2026. Every case survives with its actor changed and its reason
 * restated: the person who attended the machine and took the signature is the
 * person who submits it, and the office — Master and Coordinator alike — is
 * refused, which is the same shape of assertion pointing the other way.
 */
describe('the final submission is the technician’s — CR-07', () => {
  let harness: Harness;
  let signed: Job;

  beforeEach(async () => {
    harness = buildHarness();
    const ready = await workUpToSignature(harness);
    signed = await captureSignature(harness.as(technician), ready, {
      customerName: 'Pieter',
      customerSurname: 'Nel',
      strokeData: 'M0,0 L1,1',
    });
  });

  it('refuses the MASTER, and sends the customer nothing', async () => {
    /*
     * INVERTED FROM "refuses the TECHNICIAN". The old rule kept the customer's
     * copy behind a Master; the confirmed one keeps it behind the person who
     * did the work. What has not changed is that a refusal must leave the job
     * untouched and send nothing — which is what the rest of this case checks.
     */
    const before = (await harness.outbox.list()).length;

    await expect(
      issueJobCard(harness.as(master), signed, 'pieter@example-demo.co.za', 'Pieter Nel'),
    ).rejects.toThrow(/cannot be submitted by you/i);

    const after = await harness.repos.jobs.findById(signed.id);
    expect(after?.status).toBe('review');
    expect(after?.finalDocument).toBeNull();
    expect(await harness.outbox.list()).toHaveLength(before);
  });

  it('refuses the COORDINATOR, whose office role is the refusal and nothing else', async () => {
    await expect(
      issueJobCard(harness.as(coordinator), signed, 'pieter@example-demo.co.za', 'Pieter Nel'),
    ).rejects.toThrow(/cannot be submitted by you/i);
    expect((await harness.repos.jobs.findById(signed.id))?.finalDocument).toBeNull();
  });

  it('lets the TECHNICIAN submit it, and only then is the customer emailed', async () => {
    const result = await issueJobCard(
      harness.as(technician),
      signed,
      'pieter@example-demo.co.za',
      'Pieter Nel',
    );

    expect(result.job.status).toBe('awaiting_delivery');
    expect(result.job.finalDocument).not.toBeNull();
    const sent = await harness.outbox.list();
    const toCustomer = sent.filter((entry) => entry.to.includes('pieter@example-demo.co.za'));
    expect(toCustomer).toHaveLength(1);
    // The customer's copy, attached — not a bare notification.
    expect(toCustomer[0]?.attachments.length).toBeGreaterThan(0);
  });

  it('tells the office it happened, once each, and links to the JOB', async () => {
    /*
     * The notification that survived, moved and reworded. CR-07: the office is
     * told what HAS happened — a customer has been emailed their job card, and
     * they invoice from it — rather than asked to review something. So it is
     * filed here, at the submission, not at the signature, and it points at
     * the job rather than at the review screen, because there is nothing to
     * review.
     */
    await issueJobCard(harness.as(technician), signed, 'pieter@example-demo.co.za', 'Pieter Nel');

    for (const person of [master, coordinator]) {
      const raised = of(await inboxOf(harness, person.id), 'job_submitted', signed.id);
      expect(raised, person.id).toHaveLength(1);
      expect(raised[0]?.link).toBe(`/jobs/${signed.jobNumber}`);
      expect(raised[0]?.title).toContain('job card submitted');
      expect(raised[0]?.body).not.toMatch(/review|waiting for a Master/i);
    }

    // And still not the technician: they are the person who just did it.
    expect(of(await inboxOf(harness, technician.id), 'job_submitted', signed.id)).toHaveLength(0);
  });
});
