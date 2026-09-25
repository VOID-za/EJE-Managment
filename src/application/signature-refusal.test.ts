import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptJob,
  resolveSignatureRefusal,
  addLabour,
  captureSignature,
  confirmJobCardDelivery,
  issueJobCard,
  recordSignatureRefusal,
  saveCompletionReport,
  startCompletion,
  startSignature,
} from './job-operations';
import { WorkflowError } from './errors';
import { buildHarness, seedUser, type Harness } from './test-harness';
import {
  canEditJob,
  canTransition,
  can,
  checkReadyForSubmission,
  checkRefusalReason,
  checkSignatureOutcome,
  currentRefusal,
  isSignatureRefused,
  JOB_PROGRESS_STAGES,
  JOB_STATUS_ORDER,
  jobProgressPosition,
  jobStatusLabel,
  refusalAwaitingResolution,
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

    expect(currentRefusal(refused)).not.toBeNull();
    expect(currentRefusal(refused)?.refused).toBe(true);
    expect(currentRefusal(refused)?.reason).toBe(REASON);
    expect(isSignatureRefused(refused)).toBe(true);
    expect(signatureOutcomeOf(refused)).toBe('refused');
  });

  it('records who took the refusal and when', async () => {
    const job = await readyToSign();
    const refused = await recordSignatureRefusal(harness.as(technician), job, { reason: REASON });

    expect(currentRefusal(refused)?.recordedBy).toBe(technician.id);
    expect(currentRefusal(refused)?.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Not yet reviewed: that is a separate act, by a different person.
    expect(currentRefusal(refused)?.resolvedBy).toBeNull();
    expect(currentRefusal(refused)?.resolvedAt).toBeNull();
  });

  it('survives a reload, because it was written through the repository', async () => {
    const job = await readyToSign();
    await recordSignatureRefusal(harness.as(technician), job, { reason: REASON });

    const reread = await harness.repos.jobs.findByJobNumber('EJE-1048');
    expect(currentRefusal(reread!)?.reason).toBe(REASON);
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

  it.each(['no', 'n/a', 'x', '.', 'Customer unavailable', 'Customer refused'])(
    'accepts a short but real reason: %s',
    async (reason) => {
      const job = await readyToSign();
      const refused = await recordSignatureRefusal(harness.as(technician), job, { reason });
      // Presence is the rule. The system does not get to decide whether a
      // technician's explanation is a good one.
      expect(currentRefusal(refused)?.reason).toBe(reason);
    },
  );

  it('trims the stored reason', async () => {
    const job = await readyToSign();
    const refused = await recordSignatureRefusal(harness.as(technician), job, {
      reason: `  ${REASON}  `,
    });
    expect(currentRefusal(refused)?.reason).toBe(REASON);
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
    expect(currentRefusal(reread!)?.reason).toBe(REASON);
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

  it('writes one audit event naming the person, the moment and the fact', async () => {
    const job = await readyToSign();
    const refused = await recordSignatureRefusal(harness.as(technician), job, { reason: REASON });

    const events = await harness.repos.activity.list(refused.id);
    const event = events.find((entry) => entry.type === 'customer_refused_to_sign');
    expect(event).toBeDefined();
    expect(event?.summary).toBe('Customer refused to sign');
    expect(event?.detail).toContain('Sipho');
    expect(event?.actorId).toBe(technician.id);
    expect(event?.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  /*
   * The reason belongs to the job, not to the trail.
   *
   * The audit trail is a SEPARATE store with its own read path, and the refusal
   * viewer rule (`canSeeSignatureRefusal`) governs the refusal record. While the
   * reason was copied into the audit detail there were two copies under two sets
   * of rules, and the looser one won: a technician who had correctly been handed
   * a redacted job read the reason verbatim on the activity feed.
   *
   * So this asserts the ABSENCE, which is the rule. The event still says a
   * refusal happened, on which job, by whom and when — which is what an audit
   * trail is for — and points at where the reason is kept.
   */
  it('keeps the customer’s reason OFF the audit trail', async () => {
    const job = await readyToSign();
    const refused = await recordSignatureRefusal(harness.as(technician), job, { reason: REASON });

    const events = await harness.repos.activity.list(refused.id);
    for (const event of events) {
      expect(event.detail, `${event.type} detail`).not.toContain(REASON);
      expect(event.summary, `${event.type} summary`).not.toContain(REASON);
    }

    const event = events.find((entry) => entry.type === 'customer_refused_to_sign');
    expect(event?.detail).toContain('The reason is stored on the job.');

    // And it is genuinely still recorded, where the redaction rules reach it.
    expect(currentRefusal(refused)?.reason).toBe(REASON);
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

  it('is filed once a Master has resolved the refusal on the job', async () => {
    const before = (await masterInbox()).filter(
      (entry) => entry.type === 'signature_refused' && entry.handledAt === null,
    );
    expect(before.length).toBeGreaterThan(0);

    await resolveSignatureRefusal(harness.as(master), refused, 'Spoke to the customer.');

    const after = (await masterInbox()).filter(
      (entry) => entry.type === 'signature_refused' && entry.handledAt === null,
    );
    expect(after).toHaveLength(0);
  });
});

describe('a Master resolving the refusal', () => {
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

  it('belongs to the office — Master and Coordinator — and to nobody else', () => {
    // Correcting a job card the customer objected to is administration, which
    // is the Coordinator's work as much as a Master's. A technician has no
    // part in it: they are the person the customer turned away.
    for (const capability of [
      'jobs.resolveSignatureRefusal',
      'jobs.resubmitForSignature',
      'jobs.editSubmittedJob',
      'jobs.viewAnySignatureRefusal',
    ] as const) {
      expect(can('master', capability), capability).toBe(true);
      expect(can('coordinator', capability), capability).toBe(true);
      expect(can('technician', capability), capability).toBe(false);
    }
    // And the Coordinator is still not a technician.
    expect(can('coordinator', 'jobs.acceptField')).toBe(false);
  });

  it('refuses a technician trying to clear their own refusal', async () => {
    expect(
      await refusalCodes(resolveSignatureRefusal(harness.as(technician), refused, '')),
    ).toContain('not_permitted');
  });

  it('records who resolved it, when, and what they decided', async () => {
    const reviewed = await resolveSignatureRefusal(
      harness.as(master),
      refused,
      'Customer confirmed the work by telephone.',
    );

    expect(currentRefusal(reviewed)?.resolvedBy).toBe(master.id);
    expect(currentRefusal(reviewed)?.resolvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(currentRefusal(reviewed)?.resolutionNote).toBe(
      'Customer confirmed the work by telephone.',
    );
    // The refusal itself is never rewritten by the resolution.
    expect(currentRefusal(reviewed)?.reason).toBe(REASON);
    expect(reviewed.signature).toBeNull();
  });

  it('audits the resolution, in words that are about the refusal', async () => {
    await resolveSignatureRefusal(harness.as(master), refused, 'Invoice to proceed.');

    const events = await harness.repos.activity.list(refused.id);
    const event = events.find((entry) => entry.type === 'signature_refusal_resolved');
    expect(event).toBeDefined();
    expect(event?.actorId).toBe(master.id);
    expect(event?.summary).toBe('Signature refusal resolved');
    expect(event?.detail).toContain('Signature refusal resolved by Elmarie Coetzee');
    expect(event?.detail).toContain('to close without a signature');
    // The office's own decision and note, never the customer's reason: see
    // "keeps the customer's reason OFF the audit trail" above.
    expect(event?.detail).not.toContain(REASON);
    expect(event?.detail).toContain('Note: Invoice to proceed.');
  });

  it('audits a resolution with no note, without a dangling label', async () => {
    await resolveSignatureRefusal(harness.as(master), refused, '   ');

    const events = await harness.repos.activity.list(refused.id);
    const event = events.find((entry) => entry.type === 'signature_refusal_resolved');
    expect(event?.detail).toContain('Signature refusal resolved by Elmarie Coetzee');
    expect(event?.detail).toContain('to close without a signature');
    expect(event?.detail).not.toContain('Note:');
  });

  it('never calls the resolution a review by the office', async () => {
    await resolveSignatureRefusal(harness.as(master), refused, 'Invoice to proceed.');

    const events = await harness.repos.activity.list(refused.id);
    for (const event of events) {
      expect(`${event.summary} ${event.detail}`, event.type).not.toMatch(/master review/i);
    }
  });

  it('cannot be resolved twice', async () => {
    const reviewed = await resolveSignatureRefusal(harness.as(master), refused, '');
    expect(
      await refusalCodes(resolveSignatureRefusal(harness.as(master), reviewed, '')),
    ).toContain('already_resolved');
  });

  it('refuses to resolve a job that has no refusal', async () => {
    const other = await harness.repos.jobs.findByJobNumber('EJE-1058');
    expect(
      await refusalCodes(resolveSignatureRefusal(harness.as(master), other!, '')),
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

  it('adds no status to the workflow, and none to the status filter', () => {
    // The refusal is a condition on the job. Nothing new is selectable, nothing
    // new is countable, and nothing new is labelled.
    expect(JOB_STATUS_ORDER).toContain('review');
    for (const status of JOB_STATUS_ORDER) {
      expect(jobStatusLabel(status), status).not.toMatch(/refus|master review/i);
    }
  });

  it('CLOSES the job — "Without Customer Signature" is an ending, not a flag', async () => {
    /*
     * MASTER SCOPE REF-8. This asserted that resolving "clears a condition. It
     * does not move the job" — and that is the defect acceptance testing
     * found: the job correctly recorded "Issued without a signature" and then
     * carried on showing steps 5 Review and 6 Closed with a Capture Signature
     * button, because nothing had moved.
     *
     * "The job is CLOSED immediately. There must be NO subsequent Customer
     * Signature step. There must be NO Review step after this."
     */
    expect(refused.status).toBe('review');
    const resolved = await resolveSignatureRefusal(harness.as(master), refused, 'Proceed.');

    expect(resolved.status).toBe('closed');
    expect(resolved.closedAt).not.toBeNull();
    expect(jobProgressPosition(resolved.status).index).toBe(
      JOB_PROGRESS_STAGES.indexOf('closed'),
    );
    // And the customer's copy exists, recording that they declined.
    expect(resolved.finalDocument).not.toBeNull();
  });

  it('leaves no way back into the signature or review steps', async () => {
    const resolved = await resolveSignatureRefusal(harness.as(master), refused, '');

    expect(canTransition(resolved.status, 'customer_signature')).toBe(false);
    expect(canTransition(resolved.status, 'review')).toBe(false);
    expect(canEditJob('master', resolved.status)).toBe(false);
    expect(canEditJob('coordinator', resolved.status)).toBe(false);
    expect(canEditJob('technician', resolved.status)).toBe(false);
  });

  it('cannot be resolved twice', async () => {
    await resolveSignatureRefusal(harness.as(master), refused, '');
    const again = await harness.repos.jobs.findById(refused.id);

    await expect(
      resolveSignatureRefusal(harness.as(master), again!, ''),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('never calls the exception Master Review, anywhere it is named', () => {
    expect(signatureExceptionLabel(refused)).not.toMatch(/master review/i);
    expect(checkReadyForSubmission(refused).violations.map((v) => v.message).join(' ')).not.toMatch(
      /master review/i,
    );
  });

  it('introduces no Master Review state', async () => {
    expect(refused.status).not.toBe('submitted');
    const reread = await harness.repos.jobs.findByJobNumber('EJE-1048');
    expect(reread?.status).toBe('review');
  });

  it('holds the job card until a Master has resolved it', () => {
    expect(refusalAwaitingResolution(refused)).toBe(true);
    const readiness = checkReadyForSubmission(refused);
    expect(readiness.allowed).toBe(false);
    expect(readiness.violations.map((violation) => violation.code)).toContain(
      'refusal_unresolved',
    );
  });

  it('refuses to issue the job card while the signature refusal is unresolved', async () => {
    expect(
      await refusalCodes(
        issueJobCard(harness.as(technician), refused, 'accounts@example.com', 'ABC Engineering'),
      ),
    ).toContain('refusal_unresolved');
  });

  it('produces the customer copy and closes, in one act', async () => {
    /*
     * MASTER SCOPE REF-8. This resolved the refusal and then issued the job
     * card separately, closing on a confirmed delivery — three steps. Resolving
     * "Without Customer Signature" is now the ending: it renders and stores the
     * unsigned copy through the same pipeline the signed route uses, and
     * closes.
     *
     * Issuing afterwards is refused, because there is nothing left to issue.
     */
    const closed = await resolveSignatureRefusal(harness.as(master), refused, '');

    expect(closed.status).toBe('closed');
    expect(closed.finalDocument).not.toBeNull();
    expect(closed.finalDocument?.pageCount).toBeGreaterThan(0);

    await expect(
      issueJobCard(harness.as(technician), closed, 'accounts@example.com', 'ABC Engineering'),
    ).rejects.toBeInstanceOf(WorkflowError);

    // And the refusal is still exactly what the technician recorded.
    expect(currentRefusal(closed)?.reason).toBe(REASON);
    expect(closed.signature).toBeNull();
  });

  it('never asks the technician for a second signature', async () => {
    const reviewed = await resolveSignatureRefusal(harness.as(master), refused, '');
    // The customer said no, the document says so, and a signature captured now
    // would contradict it. The job is CLOSED, so there is no signature step to
    // return to at all.
    expect(checkSignatureOutcome(reviewed, 'signed').allowed).toBe(false);
    expect(reviewed.status).toBe('closed');
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
    expect(currentRefusal(signed)).toBeNull();
    expect(signed.pricingSnapshot?.reason).toBe('customer_signature');
    expect(signatureExceptionLabel(signed)).toBeNull();
    expect(checkReadyForSubmission(signed).allowed).toBe(true);

    const result = await issueJobCard(harness.as(technician),
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

/**
 * Presence, and nothing beyond presence.
 *
 * There was briefly a minimum length here. It was invented rather than asked
 * for, and it is the wrong kind of rule: the business requires a refusal to be
 * explained, not that the system judge whether the explanation is good enough.
 * These pin that down so it cannot creep back.
 */
describe('the reason rule itself', () => {
  it('rejects empty and whitespace', () => {
    expect(checkRefusalReason('').allowed).toBe(false);
    expect(checkRefusalReason('   ').allowed).toBe(false);
    expect(checkRefusalReason('\n\t').allowed).toBe(false);
    expect(checkRefusalReason('\u00a0').allowed).toBe(false);
  });

  it.each(['no', 'n/a', 'x', '.', 'Customer refused', 'Customer unavailable'])(
    'accepts any non-empty trimmed reason: %s',
    (reason) => {
      expect(checkRefusalReason(reason).allowed).toBe(true);
    },
  );

  it('accepts a longer reason too', () => {
    expect(checkRefusalReason(REASON).allowed).toBe(true);
    expect(checkRefusalReason('  Site manager off ill today.  ').allowed).toBe(true);
  });

  it('has one violation, and it is about presence', () => {
    expect(checkRefusalReason('').violations).toHaveLength(1);
    expect(checkRefusalReason('').violations[0]?.code).toBe('refusal_reason_required');
  });

  it('imposes no minimum length', async () => {
    // Asserted against the module itself: no length constant, and no rule that
    // a one-character answer trips.
    const refusalRules = await import('@/domain/job/signature-refusal');
    expect(Object.keys(refusalRules)).not.toContain('REFUSAL_REASON_MIN_LENGTH');
    for (let length = 1; length <= 12; length += 1) {
      expect(checkRefusalReason('a'.repeat(length)).allowed, `length ${length}`).toBe(true);
    }
  });
});
