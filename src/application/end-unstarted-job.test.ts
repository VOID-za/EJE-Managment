import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptJob,
  assignPrimaryTechnician,
  cancelJob,
  deleteJob,
  moveToAwaitingSpares,
  startCompletion,
} from './job-operations';
import { WorkflowError } from './errors';
import { buildHarness, seedUser, type Harness } from './test-harness';
import { canCancelJob, canDeleteJob, isUnassigned, type Job, type User } from '@/domain';

/**
 * WHO MAY TAKE A JOB OUT OF THE REGISTER, AND WHEN. MASTER SCOPE CR-11.
 *
 * Two halves, and both of them are the rule:
 *
 *   THE OFFICE      — a Master or a Coordinator. They raise jobs, so they are
 *                     the people who undo one raised in error or called off. A
 *                     technician never may.
 *   OPEN AND UNASSIGNED — nothing else. An Open job with somebody's name on it
 *                     has been GIVEN to them: they may be on their way to it,
 *                     and they may have been told about it by WhatsApp.
 *                     Removing it behind their back is not a tidy-up, so it is
 *                     refused and the office is pointed at a transfer instead.
 *
 * What was wrong before: the predicates asked `role === 'master'`, so the
 * Coordinator was never offered either action; and neither asked about
 * assignment — cancellation ignored it entirely, and deletion asked `acceptedAt`,
 * which is a LATER event, so a job assigned this morning and not yet accepted
 * read as nobody's.
 *
 * Every refusal below is asserted against the OPERATION, not against a button:
 * calling the API by hand on an assigned or started job has to fail.
 */

const elmarie = seedUser('user-master-elmarie');
const christene = seedUser('user-coord-christene');
const sipho = seedUser('user-tech-sipho');

/** EJE-1066: Open, and nobody is named on it. */
const unassignedOpenJob = async (harness: Harness): Promise<Job> => {
  const job = await harness.repos.jobs.findByJobNumber('EJE-1066');
  if (job === null) throw new Error('EJE-1066 is not seeded');
  expect(job.status).toBe('open');
  expect(isUnassigned(job)).toBe(true);
  return job;
};

/** EJE-1048: Open, and already given to a technician. */
const assignedOpenJob = async (harness: Harness): Promise<Job> => {
  const job = await harness.repos.jobs.findByJobNumber('EJE-1048');
  if (job === null) throw new Error('EJE-1048 is not seeded');
  expect(job.status).toBe('open');
  expect(isUnassigned(job)).toBe(false);
  return job;
};

const reason = { reason: 'duplicate', description: 'Raised twice by the office.' } as const;

const refuses = async (run: () => Promise<unknown>, expected: RegExp): Promise<void> => {
  await expect(run()).rejects.toBeInstanceOf(WorkflowError);
  try {
    await run();
  } catch (cause) {
    expect((cause as WorkflowError).message).toMatch(expected);
  }
};

describe('CANCEL-1 / CANCEL-2 / DELETE-1 / DELETE-2 — the office, on an Open unassigned job', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('CANCEL-1: a Master may cancel it, and does', async () => {
    const job = await unassignedOpenJob(harness);
    expect(canCancelJob('master', job)).toBe(true);

    const cancelled = await cancelJob(harness.as(elmarie), job, reason);
    expect(cancelled.status).toBe('cancelled');
  });

  it('CANCEL-2: a Coordinator may cancel it, and does', async () => {
    const job = await unassignedOpenJob(harness);
    expect(canCancelJob('coordinator', job)).toBe(true);

    const cancelled = await cancelJob(harness.as(christene), job, reason);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancellation?.cancelledBy).toBe(christene.id);
  });

  it('DELETE-1: a Master may delete it, and does', async () => {
    const job = await unassignedOpenJob(harness);
    expect(canDeleteJob('master', job)).toBe(true);

    await deleteJob(harness.as(elmarie), job, 'Raised against the wrong customer.');
    expect(await harness.repos.jobs.findByJobNumber('EJE-1066')).toBeNull();
  });

  it('DELETE-2: a Coordinator may delete it, and does', async () => {
    const job = await unassignedOpenJob(harness);
    expect(canDeleteJob('coordinator', job)).toBe(true);

    await deleteJob(harness.as(christene), job, 'Duplicate of EJE-1065.');
    expect(await harness.repos.jobs.findByJobNumber('EJE-1066')).toBeNull();
  });

  it('a technician may do neither, whatever the job', async () => {
    const job = await unassignedOpenJob(harness);
    expect(canCancelJob('technician', job)).toBe(false);
    expect(canDeleteJob('technician', job)).toBe(false);

    await refuses(() => cancelJob(harness.as(sipho), job, reason), /Only the office/);
    await refuses(() => deleteJob(harness.as(sipho), job, 'Not mine.'), /Only the office/);
  });
});

describe('CANCEL-3 / DELETE-3…5 — every other state is refused', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  /** Drives the seeded unassigned job into a later state. */
  const inState = async (
    status: 'in_progress' | 'awaiting_spares' | 'completion',
    actor: User = sipho,
  ): Promise<Job> => {
    const job = await unassignedOpenJob(harness);
    const accepted = await acceptJob(harness.as(actor), job);
    if (status === 'in_progress') return accepted;
    if (status === 'awaiting_spares') {
      return moveToAwaitingSpares(harness.as(actor), accepted, 'Waiting on a contactor.');
    }
    return startCompletion(harness.as(actor), accepted);
  };

  it('CANCEL-3: OPEN BUT ASSIGNED is refused — "Open" alone is not the rule', async () => {
    const job = await assignedOpenJob(harness);
    expect(canCancelJob('master', job)).toBe(false);
    expect(canCancelJob('coordinator', job)).toBe(false);
    expect(canDeleteJob('master', job)).toBe(false);
    expect(canDeleteJob('coordinator', job)).toBe(false);

    await refuses(() => cancelJob(harness.as(elmarie), job, reason), /already been assigned/);
    await refuses(() => deleteJob(harness.as(christene), job, 'Duplicate.'), /already been assigned/);
  });

  it('CANCEL-3: an Open job assigned MOMENTS AGO is refused, before anybody accepts it', async () => {
    const job = await unassignedOpenJob(harness);
    const assigned = await assignPrimaryTechnician(harness.as(elmarie), job, sipho.id, 'Sipho Mahlangu');

    // Not accepted: `acceptedAt` is still null, which is exactly what used to
    // make this look deletable.
    expect(assigned.acceptedAt).toBeNull();
    expect(assigned.status).toBe('open');
    expect(canCancelJob('master', assigned)).toBe(false);
    expect(canDeleteJob('master', assigned)).toBe(false);

    await refuses(() => deleteJob(harness.as(elmarie), assigned, 'Duplicate.'), /already been assigned/);
  });

  it('CANCEL-4 / DELETE-3: accepted and in progress is refused', async () => {
    const job = await inState('in_progress');
    expect(job.status).toBe('in_progress');
    expect(canCancelJob('master', job)).toBe(false);
    expect(canDeleteJob('master', job)).toBe(false);

    await refuses(() => cancelJob(harness.as(elmarie), job, reason), /cannot be cancelled/);
    await refuses(() => deleteJob(harness.as(elmarie), job, 'Duplicate.'), /Cancel it instead/);
  });

  it('CANCEL-5 / DELETE-4: awaiting spares is refused', async () => {
    const job = await inState('awaiting_spares');
    expect(job.status).toBe('awaiting_spares');
    expect(canCancelJob('master', job)).toBe(false);
    expect(canDeleteJob('coordinator', job)).toBe(false);

    await refuses(() => cancelJob(harness.as(elmarie), job, reason), /cannot be cancelled/);
    await refuses(() => deleteJob(harness.as(christene), job, 'Duplicate.'), /Cancel it instead/);
  });

  it('the completion write-up stage is refused', async () => {
    const job = await inState('completion');
    expect(job.status).toBe('completion');
    expect(canCancelJob('master', job)).toBe(false);
    expect(canDeleteJob('master', job)).toBe(false);
  });

  it('CANCEL-6 / DELETE-5: signed, submitted, awaiting delivery and closed are all refused', async () => {
    // The seeded register carries one of each, so the states are the real ones
    // the application produces rather than hand-built records.
    for (const [jobNumber, expectedStatus] of [
      ['EJE-1054', 'review'],
      ['EJE-1055', 'submitted'],
      ['EJE-1044', 'closed'],
    ] as const) {
      const job = await harness.repos.jobs.findByJobNumber(jobNumber);
      if (job === null) throw new Error(`${jobNumber} is not seeded`);
      expect(job.status, jobNumber).toBe(expectedStatus);

      for (const role of ['master', 'coordinator', 'technician'] as const) {
        expect(canCancelJob(role, job), `${role} cancel ${jobNumber}`).toBe(false);
        expect(canDeleteJob(role, job), `${role} delete ${jobNumber}`).toBe(false);
      }

      await refuses(() => cancelJob(harness.as(elmarie), job, reason), /cannot be cancelled/);
      await refuses(() => deleteJob(harness.as(elmarie), job, 'Duplicate.'), /cannot be/);
    }
  });

  it('a job awaiting delivery — issued, with the customer holding the document — is refused', async () => {
    const job = await harness.repos.jobs.findByJobNumber('EJE-1044');
    if (job === null) throw new Error('EJE-1044 is not seeded');
    const awaiting: Job = { ...job, status: 'awaiting_delivery' };

    expect(canCancelJob('master', awaiting)).toBe(false);
    expect(canDeleteJob('master', awaiting)).toBe(false);
    await refuses(() => cancelJob(harness.as(elmarie), awaiting, reason), /cannot be cancelled/);
  });
});
