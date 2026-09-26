import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptJob,
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
import { canTransition, type Job, type JobStatus } from '@/domain';

/**
 * THE STATE MACHINE IS WHAT ENFORCES THE WORKFLOW. MASTER SCOPE AUD-7, QA-3.
 *
 * The audit at `ca1cda7` found that three status writes — in `captureSignature`,
 * `recordSignatureRefusal` and `closeOnDelivery` — set the status on the record
 * directly rather than through `transition()`, and said: "All three are legal
 * edges today and each is guarded by its own preconditions, so no illegal state
 * is reachable today — but `TRANSITIONS` is not what enforces them.
 * **Investigate before changing.**"
 *
 * INVESTIGATED, AND THE REASSURANCE WAS WRONG. An illegal edge WAS reachable.
 * `captureSignature` did carry a transition check, but it asked about the wrong
 * edge: whether the job could move to `customer_signature`, and then it wrote
 * `review`. From `completion` the question reads as legal — `completion ->
 * customer_signature` is an edge — so the check passed and the job landed on
 * `review`, which is not an edge from `completion` at all. The Customer
 * Signature stage was skipped and `TRANSITIONS` had approved something else.
 *
 * Measured before the change, through the real operations:
 *
 *     captureSignature from in_progress  -> refused
 *     captureSignature from completion   -> RESOLVED, status=review
 *
 * A fourth write had the same shape and the audit had not named it: outcome B of
 * a refusal, which closes the job.
 *
 * Every one of the four now validates the edge it actually performs. The table
 * did not change, no edge was added to it, and no status write moved: what
 * changed is which question is asked before the write.
 */
const technician = seedUser('user-tech-sipho');
const master = seedUser('user-master-elmarie');

const refusalOf = async (work: Promise<unknown>): Promise<WorkflowError | null> =>
  work.then(
    () => null,
    (error: unknown) => (error instanceof WorkflowError ? error : null),
  );

describe('the state machine enforces every status write', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  /** A job worked and written up, sitting at `completion`. */
  const atCompletion = async (): Promise<Job> => {
    const opened = await harness.repos.jobs.findByJobNumber('EJE-1048');
    const context = harness.as(technician);
    let job = await acceptJob(context, opened!);
    job = await addLabour(context, job, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 3,
      description: 'Replaced the coolant pump.',
    });
    job = await saveCompletionReport(context, job, {
      ...job.completionReport,
      workPerformed: 'Replaced the coolant pump and cleared the alarm.',
    });
    return startCompletion(context, job);
  };

  /* -- the edge that was reachable ----------------------------------------- */

  it('refuses a signature taken without reaching the signature stage', async () => {
    const job = await atCompletion();
    expect(job.status).toBe('completion');
    // The premise: this is not an edge, and never was.
    expect(canTransition('completion', 'review')).toBe(false);

    const refusal = await refusalOf(
      captureSignature(harness.as(technician), job, {
        customerName: 'Pieter',
        customerSurname: 'Nel',
        strokeData: 'M0,0 L1,1',
      }),
    );

    expect(refusal).toBeInstanceOf(WorkflowError);
    expect(refusal?.violations.map((violation) => violation.code)).toContain('illegal_transition');
    expect(refusal?.message).toContain('completion to review');

    // And nothing was written: no signature, no snapshot, no status move.
    const stored = await harness.repos.jobs.findByJobNumber('EJE-1048');
    expect(stored?.status).toBe('completion');
    expect(stored?.signature).toBeNull();
    expect(stored?.pricingSnapshot).toBeNull();
  });

  it('refuses a refusal recorded without reaching the signature stage', async () => {
    const job = await atCompletion();

    const refusal = await refusalOf(
      recordSignatureRefusal(harness.as(technician), job, {
        reason: 'not_authorised',
        note: 'The site manager was not on site.',
      } as never),
    );

    expect(refusal?.violations.map((violation) => violation.code)).toContain('illegal_transition');
    const stored = await harness.repos.jobs.findByJobNumber('EJE-1048');
    expect(stored?.signatureRefusals).toHaveLength(0);
    expect(stored?.status).toBe('completion');
  });

  /* -- and the legitimate journey is untouched ----------------------------- */

  it('still takes a signature from the signature stage', async () => {
    const context = harness.as(technician);
    const job = await startSignature(context, await atCompletion());
    expect(job.status).toBe('customer_signature');
    expect(canTransition('customer_signature', 'review')).toBe(true);

    const signed = await captureSignature(context, job, {
      customerName: 'Pieter',
      customerSurname: 'Nel',
      strokeData: 'M0,0 L1,1',
    });

    expect(signed.status).toBe('review');
    expect(signed.signature?.customerName).toBe('Pieter');
    expect(signed.pricingSnapshot).not.toBeNull();
  });

  it('still records a refusal from the signature stage', async () => {
    const context = harness.as(technician);
    const job = await startSignature(context, await atCompletion());

    const refused = await recordSignatureRefusal(context, job, {
      reason: 'not_authorised',
      note: 'The site manager was not on site.',
    } as never);

    expect(refused.status).toBe('review');
    expect(refused.signatureRefusals).toHaveLength(1);
  });

  /* -- closing on delivery, which the table now has a say in --------------- */

  it('closes on a confirmed delivery, and only from awaiting delivery', async () => {
    const context = harness.as(technician);
    const signed = await captureSignature(
      context,
      await startSignature(context, await atCompletion()),
      { customerName: 'Pieter', customerSurname: 'Nel', strokeData: 'M0,0 L1,1' },
    );
    const issued = await issueJobCard(
      context,
      signed,
      'customer@example-demo.co.za',
      'Pieter Nel',
    );
    expect(issued.job.status).toBe('awaiting_delivery');
    expect(canTransition('awaiting_delivery', 'closed')).toBe(true);

    /*
     * The simulator stands in for the provider's delivery report, which is the
     * only thing allowed to close a job. `confirmJobCardDelivery` asks it; it
     * does not take the asking as an answer.
     */
    const messageId = issued.job.delivery?.messageId ?? '';
    expect(messageId).not.toBe('');
    harness.outbox.setDelivery(messageId, 'delivered');

    const closed = await confirmJobCardDelivery(harness.as(master), issued.job);
    expect(closed.status).toBe('closed');
    expect(closed.closedAt).not.toBeNull();
  });

  it('does not close a job twice', async () => {
    const context = harness.as(technician);
    const signed = await captureSignature(
      context,
      await startSignature(context, await atCompletion()),
      { customerName: 'Pieter', customerSurname: 'Nel', strokeData: 'M0,0 L1,1' },
    );
    const issued = await issueJobCard(
      context,
      signed,
      'customer@example-demo.co.za',
      'Pieter Nel',
    );
    harness.outbox.setDelivery(issued.job.delivery?.messageId ?? '', 'delivered');
    const closed = await confirmJobCardDelivery(harness.as(master), issued.job);
    expect(closed.status).toBe('closed');

    /*
     * `closed` is terminal: the table gives it no edges at all, so asking again
     * cannot close it a second time and cannot stamp a second `closedAt`.
     */
    expect(canTransition('closed', 'closed')).toBe(false);
    const again = await confirmJobCardDelivery(harness.as(master), closed);
    expect(again.closedAt).toBe(closed.closedAt);
  });

  /* -- the table itself, so the premises above cannot rot ------------------ */

  it('holds the edges these rules are written against', () => {
    const legal: readonly (readonly [JobStatus, JobStatus])[] = [
      ['customer_signature', 'review'],
      ['review', 'closed'],
      ['review', 'awaiting_delivery'],
      ['awaiting_delivery', 'closed'],
      ['completion', 'customer_signature'],
    ];
    const illegal: readonly (readonly [JobStatus, JobStatus])[] = [
      ['completion', 'review'],
      ['in_progress', 'review'],
      ['closed', 'review'],
      ['closed', 'closed'],
      ['review', 'review'],
    ];

    for (const [from, to] of legal) expect(canTransition(from, to), `${from} -> ${to}`).toBe(true);
    for (const [from, to] of illegal) expect(canTransition(from, to), `${from} -> ${to}`).toBe(false);
  });
});
