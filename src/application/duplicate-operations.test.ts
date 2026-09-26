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
import { WorkflowError } from './errors';
import { buildHarness, seedUser, type Harness } from './test-harness';
import type { Job } from '@/domain';

/**
 * A STALE COPY DOES NOT GET A SECOND GO. MASTER SCOPE IDEM-2.
 *
 * Every guard in `job-operations` asks a `Job` OBJECT what state it is in, and
 * that object is exactly as old as whenever its holder read it. `acceptJob` and
 * `issueJobCard` are the two where that matters, because neither can be undone:
 * acceptance starts a job against a technician's name, and issuing renders the
 * customer's copy, freezes the recipient onto it and emails it.
 *
 * Measured here before the fix, with the SAME signed job handed to
 * `issueJobCard` twice — which is a tablet that has not heard about the first
 * submission, and nothing more exotic than that:
 *
 *     second call → resolved, customer emailed a SECOND job card
 *
 * The API never saw this, because a request re-reads the job on its way in and
 * therefore happened to hold a fresh copy. That is luck, not a rule: the rule
 * belongs where the decision is made. Both operations now re-read and hold
 * themselves to the STORED status, and the refusal is the ordinary one the
 * workflow already had — no new code, no new message.
 *
 * WHAT THIS FILE DOES NOT COVER, deliberately: two operations running at the
 * same instant. Nothing here can serialise them — this harness has no
 * transaction and no unit of work — and nothing should try, because that is the
 * WRITE BOUNDARY's job: the row version on PostgreSQL, the serialised
 * `runtime.write` in the demonstration. `duplicate-operations.test.ts` in
 * `src/server/api` drives concurrent requests through the real routes and is
 * where that is proven.
 */
const technician = seedUser('user-tech-sipho');

const workAndSign = async (harness: Harness, jobNumber: string): Promise<Job> => {
  const opened = await harness.repos.jobs.findByJobNumber(jobNumber);
  expect(opened).not.toBeNull();
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
  job = await startCompletion(context, job);
  job = await startSignature(context, job);
  return captureSignature(context, job, {
    customerName: 'Pieter',
    customerSurname: 'Nel',
    strokeData: 'M0,0 L1,1',
  });
};

/** The signed job cards that actually went out. */
const customerCopies = (harness: Harness, jobNumber: string): number =>
  harness.outbox.listSync().filter((entry) => entry.subject.startsWith(jobNumber)).length;

describe('a stale job cannot be accepted or issued a second time', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('issues once, however stale the copy the caller is holding', async () => {
    const signed = await workAndSign(harness, 'EJE-1048');
    const context = harness.as(technician);

    await issueJobCard(context, signed, 'customer@example-demo.co.za', 'Pieter Nel');

    /*
     * THE SAME OBJECT, AGAIN. It still says `review`, because it was read
     * before the submission and nothing has told it otherwise — which is
     * precisely the tablet that has been in a pocket since this morning.
     */
    const second = await issueJobCard(
      context,
      signed,
      'customer@example-demo.co.za',
      'Pieter Nel',
    ).then(
      () => null,
      (error: unknown) => error as WorkflowError,
    );

    expect(second).toBeInstanceOf(WorkflowError);
    expect(second?.violations.map((violation) => violation.code)).toContain('not_ready_to_issue');
    expect(customerCopies(harness, 'EJE-1048')).toBe(1);
  });

  it('leaves the issued job exactly as the first submission left it', async () => {
    const signed = await workAndSign(harness, 'EJE-1048');
    const context = harness.as(technician);

    const issued = await issueJobCard(
      context,
      signed,
      'customer@example-demo.co.za',
      'Pieter Nel',
    );
    await issueJobCard(context, signed, 'customer@example-demo.co.za', 'Pieter Nel').catch(
      () => undefined,
    );

    const stored = await harness.repos.jobs.findByJobNumber('EJE-1048');
    /*
     * The document, the recipient and the delivery record are the first
     * submission's. A refusal that re-stamped any of them would be a second
     * submission wearing a refusal's clothes.
     */
    expect(stored?.finalDocument?.storageKey).toBe(issued.job.finalDocument?.storageKey);
    expect(stored?.finalDocument?.generatedAt).toBe(issued.job.finalDocument?.generatedAt);
    expect(stored?.delivery?.attempts).toBe(1);
    expect(stored?.status).toBe('awaiting_delivery');
  });

  it('accepts once, however stale the copy the caller is holding', async () => {
    const opened = await harness.repos.jobs.findByJobNumber('EJE-1048');
    const context = harness.as(technician);

    await acceptJob(context, opened!);

    // The open-pool copy, which still says `open`.
    const second = await acceptJob(context, opened!).then(
      () => null,
      (error: unknown) => error as WorkflowError,
    );

    expect(second).toBeInstanceOf(WorkflowError);
    expect(second?.violations.map((violation) => violation.code)).toContain('illegal_transition');
  });

  it('does not move the acceptance time when the second attempt is refused', async () => {
    const opened = await harness.repos.jobs.findByJobNumber('EJE-1048');
    const context = harness.as(technician);

    const accepted = await acceptJob(context, opened!);
    await acceptJob(context, opened!).catch(() => undefined);

    const stored = await harness.repos.jobs.findByJobNumber('EJE-1048');
    expect(stored?.acceptedAt).toBe(accepted.acceptedAt);
  });

  it('refuses a job that has been deleted out from under the caller', async () => {
    /*
     * The re-read has to cope with the record being GONE, not only changed. A
     * `findById` that answered null and was then dereferenced would turn a
     * refusal into a 500.
     */
    const opened = await harness.repos.jobs.findByJobNumber('EJE-1048');
    await harness.repos.jobs.delete(opened!.id);

    const refusal = await acceptJob(harness.as(technician), opened!).then(
      () => null,
      (error: unknown) => error as WorkflowError,
    );

    expect(refusal).toBeInstanceOf(WorkflowError);
    expect(refusal?.violations.map((violation) => violation.code)).toContain('job_not_found');
  });
});
