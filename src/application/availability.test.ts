import { beforeEach, describe, expect, it } from 'vitest';
import {
  cancelAvailability,
  checkAvailabilityInput,
  createAvailability,
  loadAvailabilityTimeline,
  updateAvailability,
} from './availability-operations';
import {
  addAdditionalTechnician,
  assignPrimaryTechnician,
  rescheduleJob,
  transferJobToTechnician,
} from './job-operations';
import { WorkflowError } from './errors';
import { buildHarness, dayOffset, seedUser, type Harness } from './test-harness';
import { asUserId, findJobAvailabilityConflicts, type Job } from '@/domain';

/**
 * Technician availability.
 *
 * The rule that earns its keep: an official unavailability must stop a
 * technician being put on overlapping work, in the domain rather than in the
 * calendar UI. These tests come at that rule from every direction a screen
 * could — assignment, an extra hand, a transfer and a reschedule.
 */
const elmarie = seedUser('user-master-elmarie');
const sipho = seedUser('user-tech-sipho');
const lerato = seedUser('user-tech-lerato');

const baseInput = {
  userId: sipho.id,
  type: 'appointment' as const,
  startDate: dayOffset(0),
  endDate: dayOffset(0),
  allDay: false,
  startTime: '09:00',
  endTime: '11:00',
  description: 'Doctor',
};

const jobNumbered = async (harness: Harness, jobNumber: string): Promise<Job> => {
  const job = await harness.repos.jobs.findByJobNumber(jobNumber);
  if (job === null) throw new Error(`${jobNumber} is not seeded`);
  return job;
};

describe('validating an availability period', () => {
  it('accepts a part-day window', () => {
    expect(checkAvailabilityInput(baseInput)).toHaveLength(0);
  });

  it('accepts a full day', () => {
    expect(
      checkAvailabilityInput({ ...baseInput, allDay: true, startTime: null, endTime: null }),
    ).toHaveLength(0);
  });

  it('accepts a multi-day block', () => {
    expect(
      checkAvailabilityInput({
        ...baseInput,
        endDate: dayOffset(4),
        allDay: true,
        startTime: null,
        endTime: null,
      }),
    ).toHaveLength(0);
  });

  it('refuses an end date before the start', () => {
    const violations = checkAvailabilityInput({ ...baseInput, endDate: dayOffset(-1) });
    expect(violations.map((violation) => violation.code)).toContain('end_before_start');
  });

  it('refuses an end time before the start time', () => {
    const violations = checkAvailabilityInput({ ...baseInput, endTime: '08:00' });
    expect(violations.map((violation) => violation.code)).toContain('end_time_before_start');
  });

  it('refuses a time window spanning more than one day', () => {
    const violations = checkAvailabilityInput({ ...baseInput, endDate: dayOffset(2) });
    expect(violations.map((violation) => violation.code)).toContain('multi_day_must_be_all_day');
  });

  it('requires a description when the type is Other', () => {
    const violations = checkAvailabilityInput({
      ...baseInput,
      type: 'other',
      description: '   ',
    });
    expect(violations.map((violation) => violation.code)).toContain('description_required');
  });

  it('allows an optional description on a predefined type', () => {
    expect(
      checkAvailabilityInput({ ...baseInput, type: 'sick_leave', description: '' }),
    ).toHaveLength(0);
  });
});

describe('recording availability', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('is a Master action, not a technician one', async () => {
    await expect(
      createAvailability(harness.as(sipho), baseInput),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('stores a part day with its time window', async () => {
    const { record } = await createAvailability(harness.as(elmarie), baseInput);
    expect(record.allDay).toBe(false);
    expect(record.startTime).toBe('09:00');
    expect(record.endTime).toBe('11:00');
    expect(record.createdBy).toBe(elmarie.id);
  });

  it('clears the times on an all-day record', async () => {
    const { record } = await createAvailability(harness.as(elmarie), {
      ...baseInput,
      allDay: true,
    });
    expect(record.startTime).toBeNull();
    expect(record.endTime).toBeNull();
  });

  it('is audited with who, when and what', async () => {
    await createAvailability(harness.as(elmarie), baseInput);
    const trail = await harness.repos.activity.list();
    const entry = trail.find((event) => event.type === 'availability_created');

    expect(entry?.summary).toContain('Sipho Mahlangu');
    expect(entry?.detail).toContain('09:00–11:00');
    expect(entry?.actorId).toBe(elmarie.id);
  });

  it('records both sides of an amendment on the trail', async () => {
    const { record } = await createAvailability(harness.as(elmarie), baseInput);
    await updateAvailability(harness.as(elmarie), record, {
      ...baseInput,
      startTime: '13:00',
      endTime: '16:00',
    });

    const trail = await harness.repos.activity.list();
    const entry = trail.find((event) => event.type === 'availability_updated');
    expect(entry?.detail).toContain('09:00–11:00');
    expect(entry?.detail).toContain('13:00–16:00');
  });

  it('cancels without deleting, and stops blocking', async () => {
    const { record } = await createAvailability(harness.as(elmarie), baseInput);
    const cancelled = await cancelAvailability(harness.as(elmarie), record);

    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelledBy).toBe(elmarie.id);

    const stored = await harness.repos.availability.findById(record.id);
    expect(stored).not.toBeNull();

    const conflicts = findJobAvailabilityConflicts([cancelled], sipho.id, {
      scheduledDate: baseInput.startDate,
      scheduledEndDate: null,
      jobType: 'breakdown',
    });
    expect(conflicts).toHaveLength(0);
  });

  it('lists existing jobs inside the period without changing any of them', async () => {
    const job = await jobNumbered(harness, 'EJE-1048');
    const { affectedJobs } = await createAvailability(harness.as(elmarie), {
      ...baseInput,
      userId: job.primaryTechnicianId ?? sipho.id,
      startDate: job.scheduledDate ?? dayOffset(0),
      endDate: job.scheduledDate ?? dayOffset(0),
      allDay: true,
    });

    expect(affectedJobs.some((affected) => affected.jobNumber === 'EJE-1048')).toBe(true);

    // Not silently reassigned or unscheduled: the Master resolves it.
    const after = await jobNumbered(harness, 'EJE-1048');
    expect(after.primaryTechnicianId).toBe(job.primaryTechnicianId);
    expect(after.scheduledDate).toBe(job.scheduledDate);
    expect(after.status).toBe(job.status);
  });

  it('separates current, upcoming and past on a technician timeline', async () => {
    await createAvailability(harness.as(elmarie), { ...baseInput, allDay: true });
    await createAvailability(harness.as(elmarie), {
      ...baseInput,
      type: 'annual_leave',
      startDate: dayOffset(20),
      endDate: dayOffset(24),
      allDay: true,
      startTime: null,
      endTime: null,
    });

    const timeline = await loadAvailabilityTimeline(
      harness.as(elmarie),
      sipho.id,
      dayOffset(0),
    );
    expect(timeline.current.length).toBeGreaterThan(0);
    expect(timeline.upcoming.length).toBeGreaterThan(0);
    expect(timeline.past.length).toBeGreaterThan(0);
  });
});

describe('availability blocks job assignment', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  /** A job scheduled today, unassigned. */
  const todayJob = async (): Promise<Job> => {
    const job = await jobNumbered(harness, 'EJE-1059');
    return harness.repos.jobs.save({
      ...job,
      scheduledDate: dayOffset(0),
      primaryTechnicianId: null,
      additionalTechnicianIds: [],
    });
  };

  it('refuses to assign a technician who is unavailable that day', async () => {
    await createAvailability(harness.as(elmarie), { ...baseInput, allDay: true });
    const job = await todayJob();

    await expect(
      assignPrimaryTechnician(harness.as(elmarie), job, sipho.id, 'Sipho Mahlangu'),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('says exactly when and why', async () => {
    await createAvailability(harness.as(elmarie), baseInput);
    const job = await todayJob();

    await expect(
      assignPrimaryTechnician(harness.as(elmarie), job, sipho.id, 'Sipho Mahlangu'),
    ).rejects.toMatchObject({
      message: 'Technician unavailable',
    });

    try {
      await assignPrimaryTechnician(harness.as(elmarie), job, sipho.id, 'Sipho Mahlangu');
    } catch (cause) {
      const error = cause as WorkflowError;
      expect(error.violations[0]?.message).toContain('Sipho Mahlangu is unavailable');
      expect(error.violations[0]?.message).toContain('09:00');
      expect(error.violations[0]?.message).toContain('11:00');
      expect(error.violations[0]?.message).toContain('appointment');
    }
  });

  it('refuses an unavailable additional technician too', async () => {
    await createAvailability(harness.as(elmarie), { ...baseInput, allDay: true });
    const job = await todayJob();

    await expect(
      addAdditionalTechnician(harness.as(elmarie), job, sipho.id, 'Sipho Mahlangu'),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('refuses a transfer to an unavailable technician', async () => {
    await createAvailability(harness.as(elmarie), {
      ...baseInput,
      userId: lerato.id,
      allDay: true,
    });
    const job = await harness.repos.jobs.save({
      ...(await todayJob()),
      status: 'in_progress',
      primaryTechnicianId: sipho.id,
      acceptedAt: new Date().toISOString(),
    });

    await expect(
      transferJobToTechnician(harness.as(sipho), job, lerato.id, {
        reason: 'vehicle_problem',
        description: '',
      }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('refuses a reschedule that moves a job onto an absence', async () => {
    await createAvailability(harness.as(elmarie), {
      ...baseInput,
      startDate: dayOffset(7),
      endDate: dayOffset(7),
      allDay: true,
      startTime: null,
      endTime: null,
    });
    const job = await harness.repos.jobs.save({
      ...(await todayJob()),
      primaryTechnicianId: sipho.id,
    });

    await expect(
      rescheduleJob(harness.as(elmarie), job, dayOffset(7), null),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('allows assignment on a day the technician is available', async () => {
    await createAvailability(harness.as(elmarie), {
      ...baseInput,
      startDate: dayOffset(30),
      endDate: dayOffset(30),
      allDay: true,
      startTime: null,
      endTime: null,
    });
    const job = await todayJob();

    const saved = await assignPrimaryTechnician(
      harness.as(elmarie),
      job,
      sipho.id,
      'Sipho Mahlangu',
    );
    expect(saved.primaryTechnicianId).toBe(sipho.id);
  });

  it('never conflicts with a job that has no date yet', async () => {
    await createAvailability(harness.as(elmarie), { ...baseInput, allDay: true });
    const job = await harness.repos.jobs.save({
      ...(await todayJob()),
      scheduledDate: null,
      scheduledEndDate: null,
    });

    const saved = await assignPrimaryTechnician(
      harness.as(elmarie),
      job,
      asUserId(sipho.id),
      'Sipho Mahlangu',
    );
    expect(saved.primaryTechnicianId).toBe(sipho.id);
  });
});
