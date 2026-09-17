import type { IsoDate } from '../types/common';
import type { Job, JobTypeCode } from '../types/job';
import { getJobTypeDefinition } from './job-types';
import type { RuleViolation } from './workflow';

/**
 * Job scheduling.
 *
 * Most EJE work is a single visit. Service work is quoted for a number of days,
 * so a service job occupies a RANGE and has to be reasoned about as one — on the
 * calendar, in technician workload, and when checking for clashes.
 */

export interface ScheduleWindow {
  readonly start: IsoDate;
  /** Inclusive. Equal to `start` for single-day work. */
  readonly end: IsoDate;
  readonly days: number;
}

export const jobSchedulesRange = (jobType: JobTypeCode): boolean =>
  getJobTypeDefinition(jobType).schedulesDateRange;

const addDays = (date: IsoDate, days: number): IsoDate => {
  const parsed = new Date(`${date}T00:00:00`);
  parsed.setDate(parsed.getDate() + days);
  const year = parsed.getFullYear();
  const month = `${parsed.getMonth() + 1}`.padStart(2, '0');
  const day = `${parsed.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/** Whole days between two calendar dates, ignoring time and time zone. */
export const daysBetween = (start: IsoDate, end: IsoDate): number => {
  const from = Date.UTC(
    Number(start.slice(0, 4)),
    Number(start.slice(5, 7)) - 1,
    Number(start.slice(8, 10)),
  );
  const to = Date.UTC(
    Number(end.slice(0, 4)),
    Number(end.slice(5, 7)) - 1,
    Number(end.slice(8, 10)),
  );
  return Math.round((to - from) / 86_400_000);
};

/**
 * The window a job occupies, or null when it is not scheduled at all.
 *
 * A job type that does not schedule a range always reports a single day, even
 * if an end date is somehow present, so one rule governs the calendar.
 */
export const jobScheduleWindow = (
  job: Pick<Job, 'jobType' | 'scheduledDate' | 'scheduledEndDate'>,
): ScheduleWindow | null => {
  if (job.scheduledDate === null) return null;

  if (!jobSchedulesRange(job.jobType) || job.scheduledEndDate === null) {
    return { start: job.scheduledDate, end: job.scheduledDate, days: 1 };
  }

  // A stored end before the start would be data corruption; clamp rather than
  // render a negative-width bar.
  const span = daysBetween(job.scheduledDate, job.scheduledEndDate);
  if (span < 0) {
    return { start: job.scheduledDate, end: job.scheduledDate, days: 1 };
  }

  return { start: job.scheduledDate, end: job.scheduledEndDate, days: span + 1 };
};

/** Every calendar date a job occupies, inclusive of both ends. */
export const jobScheduledDates = (
  job: Pick<Job, 'jobType' | 'scheduledDate' | 'scheduledEndDate'>,
): readonly IsoDate[] => {
  const window = jobScheduleWindow(job);
  if (window === null) return [];

  return Array.from({ length: window.days }, (_, index) => addDays(window.start, index));
};

export const isMultiDay = (
  job: Pick<Job, 'jobType' | 'scheduledDate' | 'scheduledEndDate'>,
): boolean => (jobScheduleWindow(job)?.days ?? 1) > 1;

/** Validation for the scheduling fields on a job form. */
export const checkSchedule = (
  jobType: JobTypeCode,
  scheduledDate: IsoDate | null,
  scheduledEndDate: IsoDate | null,
): readonly RuleViolation[] => {
  const violations: RuleViolation[] = [];

  if (!jobSchedulesRange(jobType)) {
    return violations;
  }

  if (scheduledEndDate !== null && scheduledDate === null) {
    violations.push({
      code: 'end_without_start',
      message: 'A service cannot have an end date without a start date.',
    });
  }

  if (
    scheduledDate !== null &&
    scheduledEndDate !== null &&
    daysBetween(scheduledDate, scheduledEndDate) < 0
  ) {
    violations.push({
      code: 'end_before_start',
      message: 'The service end date cannot be before the start date.',
    });
  }

  return violations;
};

/** True when two scheduled jobs overlap on at least one day. */
export const schedulesOverlap = (
  a: Pick<Job, 'jobType' | 'scheduledDate' | 'scheduledEndDate'>,
  b: Pick<Job, 'jobType' | 'scheduledDate' | 'scheduledEndDate'>,
): boolean => {
  const first = jobScheduleWindow(a);
  const second = jobScheduleWindow(b);
  if (first === null || second === null) return false;

  return first.start <= second.end && second.start <= first.end;
};
