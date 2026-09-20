import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptJob,
  acknowledgeSignatureRefusal,
  addLabour,
  captureSignature,
  confirmJobCardDelivery,
  issueJobCard,
  recordSignatureRefusal,
  saveCompletionReport,
  startCompletion,
  startSignature,
} from './job-operations';
import { buildHarness, confirmDelivery, seedUser, type Harness } from './test-harness';
import {
  can,
  checkReadyForSubmission,
  checkRefusalReason,
  checkSignatureOutcome,
  isSignatureRefused,
  JOB_PROGRESS_STAGES,
  jobProgressPosition,
  jobStatusLabel,
  refusalAwaitingReview,
  signatureExceptionLabel,
  signatureOutcomeOf,
  type Job,
} from '@/domain';

/**
 * The customer who would not sign.
 *
 * These cover the rule rather than the screen: every one of them goes through
 * the same operations the wizard calls, so a refusal recorded from anywhere —
 * the wizard today, a REST call later — is held to the same conditions. The
 * wizard's own behaviour is asserted in the browser smoke suite, because there
 * is no component test runner in this project.
 */

const technician = seedUser('user-tech-sipho');
const master = seedUser('user-master-elmarie');

const REASON = 'Customer representative was not available to sign.';

/**
 * The violation codes an operation refused with.
 *
 * Asserted instead of the message text, because the codes are the contract the
 * UI branches on — the wording is free to improve without a test having to be
 * rewritten to allow it.
 */
const refusalCodes = async (run: Promise<unknown>): Promise<readonly string[]> => {
  try {
    await run;
  } catch (error) {
    const violations = (error as { violations?: readonly { code: string }[] }).violations ?? [];
    return violations.map((violation) => violation.code);
  }
  throw new Error('the operation was expected to refuse, and did not');
};

describe('recording a refusal', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  /** A breakdown taken to the point where the customer would normally sign. */
  const readyToSign = async (): Promise<Job> => {
    const context = harness.as(technician);
    const opened = await harness.repos.jobs.findByJobNumber('EJE-1048');
    let job = await acceptJob(context, opened!);
    job = await saveCompletionReport(context, job, {
      ...job.completionReport,
      workPerformed: 'Replaced the spindle drive cooling fan.',
    });
    job = await addLabour(context, job, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 2,
      description: 'Spindle drive repair',
    });
    job = await startCompletion(context, job);
    return startSignature(context, job);
  };

  it('persists the refusal as a record, not a flag', async () => {
    const job = await readyToSign();
    const refused = await recordSignatureRefusal(harness.as(technician), job, { reason: REASON });

    expect(refused.signatureRefusal).not.toBeNull();
    expect(refused.signatureRefusal?.refused).toBe(true);
    expect(refused.signatureRefusal?.reason).toBe(REASON);
    expect(isSignatureRefused(refused)).toBe(true);
    expect(signatureOutcomeOf(refused)).toBe('refused');
  });

  it('records who took the refusal and when', async () => {
    const job = await readyToSign();
    const refused = await recordSignatureRefusal(harness.as(technician), job, { reason: REASON });

    expect(refused.signatureRefusal?.recordedBy).toBe(technician.id);
    expect(refused.signatureRefusal?.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Not yet reviewed: that is a separate act, by a different person.
    expect(refused.signatureRefusal?.acknowledgedBy).toBeNull();
    expect(refused.signatureRefusal?.acknowledgedAt).toBeNull();
  });

  it('survives a reload, because it was written through the repository', async () => {
    const job = await readyToSign();
    await recordSignatureRefusal(harness.as(technician), job, { reason: REASON });

    const reread = await harness.repos.jobs.findByJobNumber('EJE-1048');
    expect(reread?.signatureRefusal?.reason).toBe(REASON);
  });

  it('leaves no customer signature behind', async () => {
    const job = await readyToSign();
    const refused = await recordSignatureRefusal(harness.as(technician), job, { reason: REASON });

    expect(refused.signature).toBeNull();
  });

  it('freezes the rates, exactly as a signature does', async () => {
    const job = await readyToSign();
    const refused = await recordSignatureRefusal(harness.as(technician), job, { reason: REASON });

    expect(refused.pricingSnapshot).not.toBeNull();
    expect(refused.pricingSnapshot?.reason).toBe('signature_refused');
  });

  it('rejects an empty reason', async () => {
    const job = await readyToSign();
    expect(
      await refusalCodes(recordSignatureRefusal(harness.as(technician), job, { reason: '' })),
    ).toContain('refusal_reason_required');
  });

  it('rejects a whitespace-only reason', async () => {
    const job = await readyToSign();
    expect(
      await refusalCodes(
        recordSignatureRefusal(harness.as(technician), job, { reason: '    \n\t  ' }),
      ),
    ).toContain('refusal_reason_required');
  });

  it('rejects a reason too short to act on', async () => {
    const job = await readyToSign();
    expect(
      await refusalCodes(recordSignatureRefusal(harness.as(technician), job, { reason: 'no' })),
    ).toContain('refusal_reason_too_short');
  });

  it('trims the stored reason', async () => {
    const job = await readyToSign();
    const refused = await recordSignatureRefusal(harness.as(technician), job, {
      reason: `  ${REASON}  `,
    });
    expect(refused.signatureRefusal?.reason).toBe(REASON);
  });

  it('will not record a refusal against a job the customer already signed', async () => {
    const job = await readyToSign();
    const signed = await captureSignature(harness.as(technician), job, {
      customerName: 'Pieter',
      customerSurname: 'Nel',
      strokeData: 'M0,0 L1,1',
    });

    expect(
      await refusalCodes(recordSignatureRefusal(harness.as(technician), signed, { reason: REASON })),
    ).toContain('already_signed');
  });

  it('will not sign a job the customer refused', async () => {
    const job = await readyToSign();
    const refused = await recordSignatureRefusal(harness.as(technician), job, { reason: REASON });

    expect(
      await refusalCodes(
        captureSignature(harness.as(technician), refused, {
          customerName: 'Pieter',
          customerSurname: 'Nel',
          strokeData: 'M0,0 L1,1',
        }),
      ),
    ).toContain('already_refused');

    // And the refusal is untouched by the attempt.
    const reread = await harness.repos.jobs.findByJobNumber('EJE-1048');
    expect(reread?.signature).toBeNull();
    expect(reread?.signatureRefusal?.reason).toBe(REASON);
  });

  it('applies the same readiness gate as a signature', async () => {
    const context = harness.as(technician);
    const opened = await harness.repos.jobs.findByJobNumber('EJE-1048');
    const bare = await acceptJob(context, opened!);

    // No write-up and no labour: a refusal is not a way around the close-out.
    const codes = await refusalCodes(recordSignatureRefusal(context, bare, { reason: REASON }));
    expect(codes).toContain('work_performed_required');
    expect(codes).toContain('labour_required');
  });

  it('writes one audit event naming the reason and the person', async () => {
    const job = await readyToSign();
    const refused = await recordSignatureRefusal(harness.as(technician), job, { reason: REASON });

    const events = await harness.repos.activity.list(refused.id);
    const event = events.find((entry) => entry.type === 'customer_refused_to_sign');
    expect(event).toBeDefined();
    expect(event?.summary).toBe('Customer refused to sign');
    expect(event?.detail).toContain(`Reason: ${REASON}`);
    expect(event?.detail).toContain('Sipho');
    expect(event?.actorId).toBe(technician.id);
    expect(event?.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('the Master notification', () => {
  let harness: Harness;
  let refused: Job;

  beforeEach(async () => {
    harness = buildHarness();
    const context = harness.as(technician);
    const opened = await harness.repos.jobs.findByJobNumber('EJE-1048');
    let job = await acceptJob(context, opened!);
    job = await saveCompletionReport(context, job, {
      ...job.completionReport,
      workPerformed: 'Replaced the spindle drive cooling fan.',
    });
    job = await addLabour(context, job, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 2,
      description: 'Spindle drive repair',
    });
    job = await startCompletion(context, job);
    job = await startSignature(context, job);
    refused = await recordSignatureRefusal(context, job, { reason: REASON });
  });

  const masterInbox = async () => harness.repos.notifications.list(master.id);

  it('reaches a Master', async () => {
    const inbox = await masterInbox();
    expect(inbox.some((notification) => notification.type === 'signature_refused')).toBe(true);
  });

  it('names the job, in the title and against the record', async () => {
    const notification = (await masterInbox()).find(
      (entry) => entry.type === 'signature_refused',
    );
    expect(notification?.title).toContain('EJE-1048');
    expect(notification?.jobId).toBe(refused.id);
  });

  it('carries the customer, the site, the machine and the technician', async () => {
    const body =
      (await masterInbox()).find((entry) => entry.type === 'signature_refused')?.body ?? '';
    expect(body).toContain('Customer:');
    expect(body).toContain('Site:');
    expect(body).toContain('Machine:');
    expect(body).toContain('Technician: Sipho Mahlangu');
  });

  it('carries the refusal reason', async () => {
    const body =
      (await masterInbox()).find((entry) => entry.type === 'signature_refused')?.body ?? '';
    expect(body).toContain(REASON);
  });

  it('links to the job', async () => {
    const notification = (await masterInbox()).find(
      (entry) => entry.type === 'signature_refused',
    );
    expect(notification?.link).toBe('/jobs/EJE-1048');
  });

  it('is a system notification, not a chat message', async () => {
    const conversations = await harness.repos.chat.listConversations(master.id);
    const bodies = (
      await Promise.all(
        conversations.map((conversation) => harness.repos.chat.listMessages(conversation.id)),
      )
    ).flat();
    expect(bodies.some((message) => message.body.includes(REASON))).toBe(false);
  });

  it('does not notify the other technicians', async () => {
    const other = seedUser('user-tech-lerato');
    const inbox = await harness.repos.notifications.list(other.id);
    expect(inbox.some((notification) => notification.type === 'signature_refused')).toBe(false);
  });

  it('is filed once a Master has reviewed the refusal on the job', async () => {
    const before = (await masterInbox()).filter(
      (entry) => entry.type === 'signature_refused' && entry.handledAt === null,
    );
    expect(before.length).toBeGreaterThan(0);

    await acknowledgeSignatureRefusal(harness.as(master), refused, 'Spoke to the customer.');

    const after = (await masterInbox()).filter(
      (entry) => entry.type === 'signature_refused' && entry.handledAt === null,
    );
    expect(after).toHaveLength(0);
  });
});

describe('a Master handling the refusal', () => {
  let harness: Harness;
  let refused: Job;

  beforeEach(async () => {
    harness = buildHarness();
    const context = harness.as(technician);
    const opened = await harness.repos.jobs.findByJobNumber('EJE-1048');
    let job = await acceptJob(context, opened!);
    job = await saveCompletionReport(context, job, {
      ...job.completionReport,
      workPerformed: 'Replaced the spindle drive cooling fan.',
    });
    job = await addLabour(context, job, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 2,
      description: 'Spindle drive repair',
    });
    job = await startCompletion(context, job);
    job = await startSignature(context, job);
    refused = await recordSignatureRefusal(context, job, { reason: REASON });
  });

  it('belongs to the Master, and to nobody else', () => {
    expect(can('master', 'jobs.reviewSignatureRefusal')).toBe(true);
    expect(can('coordinator', 'jobs.reviewSignatureRefusal')).toBe(false);
    expect(can('technician', 'jobs.reviewSignatureRefusal')).toBe(false);
  });

  it('refuses a technician trying to clear their own refusal', async () => {
    expect(
      await refusalCodes(acknowledgeSignatureRefusal(harness.as(technician), refused, '')),
    ).toContain('not_permitted');
  });

  it('records who reviewed it, when, and what they decided', async () => {
    const reviewed = await acknowledgeSignatureRefusal(
      harness.as(master),
      refused,
      'Customer confirmed the work by telephone.',
    );

    expect(reviewed.signatureRefusal?.acknowledgedBy).toBe(master.id);
    expect(reviewed.signatureRefusal?.acknowledgedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(reviewed.signatureRefusal?.acknowledgementNote).toBe(
      'Customer confirmed the work by telephone.',
    );
    // The refusal itself is never rewritten by the review.
    expect(reviewed.signatureRefusal?.reason).toBe(REASON);
    expect(reviewed.signature).toBeNull();
  });

  it('audits the review', async () => {
    await acknowledgeSignatureRefusal(harness.as(master), refused, 'Invoice to proceed.');

    const events = await harness.repos.activity.list(refused.id);
    const event = events.find((entry) => entry.type === 'signature_refusal_reviewed');
    expect(event).toBeDefined();
    expect(event?.actorId).toBe(master.id);
    expect(event?.detail).toContain('Elmarie');
    expect(event?.detail).toContain(REASON);
    expect(event?.detail).toContain('Invoice to proceed.');
  });

  it('cannot be reviewed twice', async () => {
    const reviewed = await acknowledgeSignatureRefusal(harness.as(master), refused, '');
    expect(
      await refusalCodes(acknowledgeSignatureRefusal(harness.as(master), reviewed, '')),
    ).toContain('already_reviewed');
  });

  it('refuses to review a job that has no refusal', async () => {
    const other = await harness.repos.jobs.findByJobNumber('EJE-1058');
    expect(
      await refusalCodes(acknowledgeSignatureRefusal(harness.as(master), other!, '')),
    ).toContain('no_refusal');
  });
});

describe('what the refusal does to the workflow', () => {
  let harness: Harness;
  let refused: Job;

  beforeEach(async () => {
    harness = buildHarness();
    const context = harness.as(technician);
    const opened = await harness.repos.jobs.findByJobNumber('EJE-1048');
    let job = await acceptJob(context, opened!);
    job = await saveCompletionReport(context, job, {
      ...job.completionReport,
      workPerformed: 'Replaced the spindle drive cooling fan.',
    });
    job = await addLabour(context, job, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 2,
      description: 'Spindle drive repair',
    });
    job = await startCompletion(context, job);
    job = await startSignature(context, job);
    refused = await recordSignatureRefusal(context, job, { reason: REASON });
  });

  it('lands the job at Review, like any other finished job', () => {
    expect(refused.status).toBe('review');
  });

  it('adds no seventh stage — the rail is still six', () => {
    expect(JOB_PROGRESS_STAGES).toHaveLength(6);
    expect(JOB_PROGRESS_STAGES.map(jobStatusLabel)).toEqual([
      'Open',
      'In Progress',
      'Completion',
      'Customer Signature',
      'Review',
      'Closed',
    ]);
  });

  it('puts the job at the same rail position a signed job reaches', () => {
    expect(jobProgressPosition(refused.status).index).toBe(
      JOB_PROGRESS_STAGES.indexOf('review'),
    );
    expect(jobProgressPosition(refused.status).interruption).toBeNull();
  });

  it('shows as an exception on the job, not as a status', () => {
    expect(signatureExceptionLabel(refused)).toBe('Customer refused to sign');
    expect(jobStatusLabel(refused.status)).toBe('Review');
  });

  it('introduces no Master Review state', async () => {
    expect(refused.status).not.toBe('submitted');
    const reread = await harness.repos.jobs.findByJobNumber('EJE-1048');
    expect(reread?.status).toBe('review');
  });

  it('holds the job card until a Master has reviewed it', () => {
    expect(refusalAwaitingReview(refused)).toBe(true);
    const readiness = checkReadyForSubmission(refused);
    expect(readiness.allowed).toBe(false);
    expect(readiness.violations.map((violation) => violation.code)).toContain(
      'refusal_not_reviewed',
    );
  });

  it('refuses to issue the job card while the refusal is unreviewed', async () => {
    expect(
      await refusalCodes(
        issueJobCard(harness.as(master), refused, 'accounts@example.com', 'ABC Engineering'),
      ),
    ).toContain('refusal_not_reviewed');
  });

  it('issues normally once reviewed, and closes on confirmed delivery', async () => {
    const reviewed = await acknowledgeSignatureRefusal(harness.as(master), refused, '');
    expect(checkReadyForSubmission(reviewed).allowed).toBe(true);

    const result = await issueJobCard(
      harness.as(master),
      reviewed,
      'accounts@example.com',
      'ABC Engineering',
    );

    // Issued exactly as a signed job is: one document, stored, emailed once,
    // and still not closed until the provider confirms delivery.
    expect(result.job.status).toBe('awaiting_delivery');
    expect(result.job.finalDocument).not.toBeNull();
    expect(result.emailedTo).toBe('accounts@example.com');

    const closed = await confirmDelivery(harness, harness.as(master), result.job);
    expect(closed.status).toBe('closed');
    // And the refusal is still exactly what the technician recorded.
    expect(closed.signatureRefusal?.reason).toBe(REASON);
    expect(closed.signature).toBeNull();
  });

  it('never asks the technician for a second signature', async () => {
    const reviewed = await acknowledgeSignatureRefusal(harness.as(master), refused, '');
    // The job is past the signature stage and cannot be sent back to it by
    // recording another outcome.
    expect(checkSignatureOutcome(reviewed, 'signed').allowed).toBe(false);
    expect(reviewed.status).toBe('review');
  });
});

describe('a normal signature is untouched by any of this', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('still signs, still freezes rates at the signature, still issues and closes', async () => {
    const context = harness.as(technician);
    const opened = await harness.repos.jobs.findByJobNumber('EJE-1048');
    let job = await acceptJob(context, opened!);
    job = await saveCompletionReport(context, job, {
      ...job.completionReport,
      workPerformed: 'Replaced the spindle drive cooling fan.',
    });
    job = await addLabour(context, job, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 2,
      description: 'Spindle drive repair',
    });
    job = await startCompletion(context, job);
    job = await startSignature(context, job);

    const signed = await captureSignature(context, job, {
      customerName: 'Pieter',
      customerSurname: 'Nel',
      strokeData: 'M0,0 L1,1',
    });

    expect(signed.signature?.declaration).toBe(
      'I confirm that the work described above has been completed.',
    );
    expect(signed.signatureRefusal).toBeNull();
    expect(signed.pricingSnapshot?.reason).toBe('customer_signature');
    expect(signatureExceptionLabel(signed)).toBeNull();
    expect(checkReadyForSubmission(signed).allowed).toBe(true);

    const result = await issueJobCard(
      harness.as(master),
      signed,
      'accounts@example.com',
      'ABC Engineering',
    );
    const closed = await confirmJobCardDelivery(
      harness.as(master),
      await (async () => {
        harness.outbox.setDelivery(result.job.delivery?.messageId ?? '', 'delivered');
        return result.job;
      })(),
    );
    expect(closed.status).toBe('closed');
    expect(closed.signature).not.toBeNull();
  });
});

describe('the reason rule itself', () => {
  it('rejects empty and whitespace', () => {
    expect(checkRefusalReason('').allowed).toBe(false);
    expect(checkRefusalReason('   ').allowed).toBe(false);
    expect(checkRefusalReason('\n\t').allowed).toBe(false);
  });

  it('rejects a token answer', () => {
    expect(checkRefusalReason('x').allowed).toBe(false);
    expect(checkRefusalReason('n/a').allowed).toBe(false);
    expect(checkRefusalReason('no').allowed).toBe(false);
  });

  it('accepts a reason that says something', () => {
    expect(checkRefusalReason(REASON).allowed).toBe(true);
    expect(checkRefusalReason('  Site manager off ill today.  ').allowed).toBe(true);
  });

  it('names the field it is about', () => {
    expect(checkRefusalReason('').violations[0]?.code).toBe('refusal_reason_required');
    expect(checkRefusalReason('no').violations[0]?.code).toBe('refusal_reason_too_short');
  });
});
