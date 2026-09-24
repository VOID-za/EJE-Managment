import {
  AVAILABILITY_TYPES,
  availabilityTimeLabel,
  availabilityTypeLabel,
  can,
  jobsAffectedByAbsence,
  summariseAvailability,
  userFullName,
  type AvailabilityRecord,
  type AvailabilityType,
  type IsoDate,
  type IsoTime,
  type Job,
  type UserId,
} from '@/domain';
import type { OperationContext } from './context';
import { audit } from './audit';
import { WorkflowError } from './errors';

/**
 * Official technician availability.
 *
 * Only a Master writes these. A technician saying they have an appointment is a
 * MESSAGE — the office decides what goes on the calendar, because the calendar
 * is what stops work being booked.
 *
 * Nothing here is ever deleted: cancelling sets a status, so the audit trail can
 * answer what was on the calendar, who put it there and who took it off.
 */
export interface AvailabilityInput {
  readonly userId: UserId;
  readonly type: AvailabilityType;
  readonly startDate: IsoDate;
  readonly endDate: IsoDate;
  readonly allDay: boolean;
  readonly startTime: IsoTime | null;
  readonly endTime: IsoTime | null;
  readonly description: string;
  /** Set when this was recorded from a technician's message. */
  readonly fromMessageId?: string | null;
}

/**
 * Who may write the calendar. MASTER SCOPE §3.2, §8.
 *
 * THE OFFICE, by capability — not `role === 'master'`, which is what this said
 * and which contradicted the permission matrix it was supposed to enforce.
 * `availability.manage` is held by Masters AND Coordinators; §3.2 makes the
 * Coordinator the office administrator who "runs … scheduling … day to day".
 * The result was a Coordinator who could open the calendar and was refused
 * every action on it.
 *
 * A technician still cannot: §8 says "Technician availability messages do not
 * automatically create official availability records", and that separation is
 * the whole point — they tell the office, the office decides.
 */
const assertMayManageAvailability = (context: OperationContext): void => {
  if (can(context.actor.role, 'availability.manage')) return;
  throw new WorkflowError('Only the office can record technician availability.', [
    {
      code: 'not_permitted',
      message:
        'Technicians tell the office by message; the office decides what goes on the calendar.',
    },
  ]);
};

/**
 * Validates an availability window.
 *
 * Exported so the form can check before submitting and the operation can check
 * again before writing — same rules, one implementation.
 */
export const checkAvailabilityInput = (
  input: Pick<
    AvailabilityInput,
    'type' | 'startDate' | 'endDate' | 'allDay' | 'startTime' | 'endTime' | 'description'
  >,
): readonly { readonly code: string; readonly message: string }[] => {
  const violations: { code: string; message: string }[] = [];

  if (input.startDate.length === 0) {
    violations.push({ code: 'start_required', message: 'A start date is required.' });
  }
  if (input.endDate.length === 0) {
    violations.push({ code: 'end_required', message: 'An end date is required.' });
  }
  if (
    input.startDate.length > 0 &&
    input.endDate.length > 0 &&
    input.endDate < input.startDate
  ) {
    violations.push({
      code: 'end_before_start',
      message: 'The end date cannot be before the start date.',
    });
  }

  if (!input.allDay) {
    if (input.startDate !== input.endDate) {
      violations.push({
        code: 'multi_day_must_be_all_day',
        message:
          'A period spanning more than one day is recorded as all-day. Use a time window for a single day only.',
      });
    }
    if (input.startTime === null || input.startTime.length === 0) {
      violations.push({ code: 'start_time_required', message: 'A start time is required.' });
    }
    if (input.endTime === null || input.endTime.length === 0) {
      violations.push({ code: 'end_time_required', message: 'An end time is required.' });
    }
    if (
      input.startTime !== null &&
      input.endTime !== null &&
      input.endTime.length > 0 &&
      input.endTime <= input.startTime
    ) {
      violations.push({
        code: 'end_time_before_start',
        message: 'The end time must be after the start time.',
      });
    }
  }

  // "Other" says nothing on its own, so it has to be explained.
  if (input.type === 'other' && input.description.trim().length === 0) {
    violations.push({
      code: 'description_required',
      message: 'A description is required when the type is Other.',
    });
  }

  if (!AVAILABILITY_TYPES.includes(input.type)) {
    violations.push({ code: 'unknown_type', message: 'That availability type is not recognised.' });
  }

  return violations;
};

export interface AvailabilityResult {
  readonly record: AvailabilityRecord;
  /**
   * Jobs already booked for this technician inside the new period.
   *
   * Reported, never acted on: reassigning someone's work without being asked is
   * exactly the kind of silent change that loses the office's trust. The Master
   * resolves each one.
   */
  readonly affectedJobs: readonly Job[];
}

export const createAvailability = async (
  context: OperationContext,
  input: AvailabilityInput,
): Promise<AvailabilityResult> => {
  assertMayManageAvailability(context);

  const violations = checkAvailabilityInput(input);
  if (violations.length > 0) {
    throw new WorkflowError('This availability period is not valid.', violations);
  }

  const technician = await context.repos.users.findById(input.userId);
  if (technician === null) throw new WorkflowError('That technician no longer exists.');

  const record: AvailabilityRecord = {
    id: context.services.ids.next('avail'),
    userId: input.userId,
    type: input.type,
    startDate: input.startDate,
    endDate: input.endDate,
    allDay: input.allDay,
    startTime: input.allDay ? null : input.startTime,
    endTime: input.allDay ? null : input.endTime,
    description: input.description.trim(),
    status: 'active',
    createdBy: context.actor.id,
    createdAt: context.services.clock.now(),
    cancelledBy: null,
    cancelledAt: null,
  };

  const saved = await context.repos.availability.save(record);

  await audit(context, {
    jobId: null,
    type: 'availability_created',
    summary: `${userFullName(technician)} marked unavailable`,
    detail: `${summariseAvailability(saved)}. Recorded by ${userFullName(context.actor)}.${
      saved.description.length > 0 ? ` ${saved.description}` : ''
    }`,
  });

  // Existing work is never touched — it is listed so the Master decides.
  const jobs = await context.repos.jobs.list();
  const affectedJobs = jobsAffectedByAbsence(jobs, input.userId, saved);

  return { record: saved, affectedJobs };
};

export const updateAvailability = async (
  context: OperationContext,
  existing: AvailabilityRecord,
  input: AvailabilityInput,
): Promise<AvailabilityResult> => {
  assertMayManageAvailability(context);

  const violations = checkAvailabilityInput(input);
  if (violations.length > 0) {
    throw new WorkflowError('This availability period is not valid.', violations);
  }
  if (existing.status === 'cancelled') {
    throw new WorkflowError('A cancelled availability record cannot be edited.', [
      { code: 'record_cancelled', message: 'Record a new period instead.' },
    ]);
  }

  const before = summariseAvailability(existing);
  const next: AvailabilityRecord = {
    ...existing,
    type: input.type,
    startDate: input.startDate,
    endDate: input.endDate,
    allDay: input.allDay,
    startTime: input.allDay ? null : input.startTime,
    endTime: input.allDay ? null : input.endTime,
    description: input.description.trim(),
  };

  const saved = await context.repos.availability.save(next);
  const technician = await context.repos.users.findById(saved.userId);

  await audit(context, {
    jobId: null,
    type: 'availability_updated',
    summary: `Availability amended: ${technician === null ? 'technician' : userFullName(technician)}`,
    // Both sides recorded, so the trail answers what actually changed.
    detail: `Was ${before}. Now ${summariseAvailability(saved)}. Amended by ${userFullName(context.actor)}.`,
  });

  const jobs = await context.repos.jobs.list();
  return { record: saved, affectedJobs: jobsAffectedByAbsence(jobs, saved.userId, saved) };
};

/**
 * Cancels a record.
 *
 * Deliberately not a delete: the technician was marked unavailable, and the
 * trail has to be able to say so even after the period is lifted.
 */
export const cancelAvailability = async (
  context: OperationContext,
  record: AvailabilityRecord,
): Promise<AvailabilityRecord> => {
  assertMayManageAvailability(context);
  if (record.status === 'cancelled') return record;

  const saved = await context.repos.availability.save({
    ...record,
    status: 'cancelled',
    cancelledBy: context.actor.id,
    cancelledAt: context.services.clock.now(),
  });

  const technician = await context.repos.users.findById(saved.userId);
  await audit(context, {
    jobId: null,
    type: 'availability_cancelled',
    summary: `Availability cancelled: ${technician === null ? 'technician' : userFullName(technician)}`,
    detail: `Was ${summariseAvailability(record)} (${availabilityTypeLabel(record.type)}, ${availabilityTimeLabel(record)}). Cancelled by ${userFullName(context.actor)}. The technician is available again for this period.`,
  });
  return saved;
};

/** Upcoming, current and past records for one technician. */
export interface AvailabilityTimeline {
  readonly current: readonly AvailabilityRecord[];
  readonly upcoming: readonly AvailabilityRecord[];
  readonly past: readonly AvailabilityRecord[];
  readonly cancelled: readonly AvailabilityRecord[];
}

export const loadAvailabilityTimeline = async (
  context: OperationContext,
  userId: UserId,
  today: IsoDate,
): Promise<AvailabilityTimeline> => {
  const records = await context.repos.availability.listForUser(userId);

  return {
    current: records.filter(
      (record) =>
        record.status === 'active' && record.startDate <= today && record.endDate >= today,
    ),
    upcoming: records.filter(
      (record) => record.status === 'active' && record.startDate > today,
    ),
    past: records.filter((record) => record.status === 'active' && record.endDate < today),
    cancelled: records.filter((record) => record.status === 'cancelled'),
  };
};
