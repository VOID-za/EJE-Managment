import { beforeEach, describe, expect, it } from 'vitest';
import { acceptJob, addNote, cancelJob, deleteJob } from './job-operations';
import { runSearch } from './search';
import { loadCalendar } from './calendar';
import { WorkflowError } from './errors';
import { buildHarness, dayOffset, seedUser, type Harness } from './test-harness';
import { canCancelJob, canDeleteJob, isJobInactive, type Job } from '@/domain';

/**
 * Leaving the active workflow: cancel versus delete.
 *
 * They are different events and the system must not blur them. DELETE is for a
 * job that should never have existed — a duplicate, the wrong customer. CANCEL
 * is for a real request that will not happen. Neither destroys anything: the
 * record and its audit trail survive both.
 */
const elmarie = seedUser('user-master-elmarie');
const sipho = seedUser('user-tech-sipho');

const openJob = async (harness: Harness): Promise<Job> => {
  const job = await harness.repos.jobs.findByJobNumber('EJE-1059');
  if (job === null) throw new Error('EJE-1059 is not seeded');
  expect(job.status).toBe('open');
  return job;
};

describe('deleting a job created by mistake', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('is permitted for a Master on an unaccepted open job', async () => {
    const job = await openJob(harness);
    expect(canDeleteJob('master', job)).toBe(true);
  });

  it('is refused for a technician', async () => {
    const job = await openJob(harness);
    expect(canDeleteJob('technician', job)).toBe(false);
    await expect(
      deleteJob(harness.as(sipho), job, 'Duplicate'),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('requires a reason', async () => {
    const job = await openJob(harness);
    await expect(deleteJob(harness.as(elmarie), job, '  ')).rejects.toBeInstanceOf(WorkflowError);
  });

  it('removes the job from every active list', async () => {
    const job = await openJob(harness);
    await deleteJob(harness.as(elmarie), job, 'Duplicate of EJE-1058.');

    const live = await harness.repos.jobs.list();
    expect(live.some((candidate) => candidate.jobNumber === 'EJE-1059')).toBe(false);

    const openOnly = await harness.repos.jobs.list({ statuses: ['open'] });
    expect(openOnly.some((candidate) => candidate.jobNumber === 'EJE-1059')).toBe(false);
  });

  it('keeps the record and its audit trail', async () => {
    const job = await openJob(harness);
    // Give it some history first, so the test proves the trail SURVIVES rather
    // than merely that the delete event was written.
    await addNote(harness.as(elmarie), job, 'Customer phoned to confirm access.', true);
    await deleteJob(harness.as(elmarie), job, 'Raised against the wrong customer.');

    const withDeleted = await harness.repos.jobs.list({ includeDeleted: true });
    const stored = withDeleted.find((candidate) => candidate.jobNumber === 'EJE-1059');
    expect(stored).toBeDefined();
    expect(stored?.deletedBy).toBe(elmarie.id);
    expect(stored?.deletionReason).toContain('wrong customer');
    expect(stored?.faultDescription).toBe(job.faultDescription);

    const trail = await harness.repos.activity.list(job.id);
    expect(trail.some((event) => event.type === 'job_deleted')).toBe(true);
    expect(trail.some((event) => event.type === 'note_added')).toBe(true);
  });

  it('keeps it off the calendar', async () => {
    const job = await openJob(harness);
    const scheduled = await harness.repos.jobs.save({ ...job, scheduledDate: dayOffset(1) });
    await deleteJob(harness.as(elmarie), scheduled, 'Duplicate.');

    const calendar = await loadCalendar(harness.repos, {
      from: dayOffset(-30),
      to: dayOffset(30),
    });
    expect(
      calendar.entries.some(
        (entry) => entry.kind === 'job' && entry.jobNumber === 'EJE-1059',
      ),
    ).toBe(false);
  });

  it('is refused once a technician has accepted the job', async () => {
    const job = await openJob(harness);
    const accepted = await acceptJob(harness.as(sipho), job);

    expect(canDeleteJob('master', accepted)).toBe(false);
    await expect(
      deleteJob(harness.as(elmarie), accepted, 'Changed my mind.'),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('points the Master at cancellation instead', async () => {
    const job = await openJob(harness);
    const accepted = await acceptJob(harness.as(sipho), job);

    try {
      await deleteJob(harness.as(elmarie), accepted, 'Changed my mind.');
      throw new Error('expected a refusal');
    } catch (cause) {
      expect((cause as WorkflowError).message).toContain('Cancel it instead');
    }
  });
});

describe('cancelling a job that will not happen', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('is a Master action', async () => {
    const job = await openJob(harness);
    expect(canCancelJob('master', job.status)).toBe(true);
    expect(canCancelJob('technician', job.status)).toBe(false);

    await expect(
      cancelJob(harness.as(sipho), job, { reason: 'customer_resolved', description: '' }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('records the reason, the description and who cancelled it', async () => {
    const job = await openJob(harness);
    const cancelled = await cancelJob(harness.as(elmarie), job, {
      reason: 'customer_resolved',
      description: 'Customer resolved the fault before technician dispatch.',
    });

    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancellation?.reason).toBe('customer_resolved');
    expect(cancelled.cancellation?.description).toContain('before technician dispatch');
    expect(cancelled.cancellation?.cancelledBy).toBe(elmarie.id);
    expect(cancelled.cancellation?.cancelledAt.length).toBeGreaterThan(0);
  });

  it('requires a description when the reason is Other', async () => {
    const job = await openJob(harness);
    await expect(
      cancelJob(harness.as(elmarie), job, { reason: 'other', description: '   ' }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('allows an optional description on a predefined reason', async () => {
    const job = await openJob(harness);
    const cancelled = await cancelJob(harness.as(elmarie), job, {
      reason: 'duplicate',
      description: '',
    });
    expect(cancelled.status).toBe('cancelled');
  });

  it('leaves the active workflow but keeps everything it recorded', async () => {
    const job = await openJob(harness);
    const cancelled = await cancelJob(harness.as(elmarie), job, {
      reason: 'customer_cancelled',
      description: '',
    });

    expect(isJobInactive(cancelled)).toBe(true);
    expect(cancelled.faultDescription).toBe(job.faultDescription);
    expect(cancelled.customerId).toBe(job.customerId);
    expect(cancelled.deletedAt).toBeNull();

    const openOnly = await harness.repos.jobs.list({ statuses: ['open'] });
    expect(openOnly.some((candidate) => candidate.jobNumber === 'EJE-1059')).toBe(false);
  });

  it('stays searchable', async () => {
    const job = await openJob(harness);
    await cancelJob(harness.as(elmarie), job, { reason: 'customer_resolved', description: '' });

    const results = await runSearch(harness.repos, 'EJE-1059');
    expect(results.some((result) => result.title.includes('EJE-1059'))).toBe(true);
  });

  it('is no longer an active bar on the calendar', async () => {
    const job = await openJob(harness);
    const scheduled = await harness.repos.jobs.save({ ...job, scheduledDate: dayOffset(1) });
    await cancelJob(harness.as(elmarie), scheduled, {
      reason: 'customer_resolved',
      description: '',
    });

    const calendar = await loadCalendar(harness.repos, {
      from: dayOffset(-30),
      to: dayOffset(30),
    });
    expect(
      calendar.entries.some(
        (entry) => entry.kind === 'job' && entry.jobNumber === 'EJE-1059',
      ),
    ).toBe(false);
  });

  it('is audited', async () => {
    const job = await openJob(harness);
    await cancelJob(harness.as(elmarie), job, {
      reason: 'customer_resolved',
      description: 'Fixed it themselves.',
    });

    const trail = await harness.repos.activity.list(job.id);
    const entry = trail.find((event) => event.type === 'job_cancelled');
    expect(entry?.detail).toContain('Customer resolved issue');
    expect(entry?.detail).toContain('Fixed it themselves');
    expect(entry?.actorId).toBe(elmarie.id);
  });

  it('cannot be cancelled once work has started', async () => {
    const job = await openJob(harness);
    const accepted = await acceptJob(harness.as(sipho), job);

    expect(canCancelJob('master', accepted.status)).toBe(false);
    await expect(
      cancelJob(harness.as(elmarie), accepted, { reason: 'customer_resolved', description: '' }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('is terminal — a cancelled job is not resurrected', async () => {
    const job = await openJob(harness);
    const cancelled = await cancelJob(harness.as(elmarie), job, {
      reason: 'duplicate',
      description: '',
    });
    await expect(acceptJob(harness.as(sipho), cancelled)).rejects.toBeInstanceOf(WorkflowError);
  });
});
