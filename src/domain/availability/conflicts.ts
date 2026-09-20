import type { IsoDate } from '../types/common';
import {
  availabilityTimeLabel,
  availabilityTypeLabel,
  isBlockingAvailability,
  type AvailabilityRecord,
} from '../types/availability';
import type { Job } from '../types/job';
import { jobScheduleWindow } from '../job/scheduling';

/**
 * Availability conflicts.
 *
 * The rule the business cares about: a technician must not be put on a job
 * whose scheduled period overlaps an official unavailability. It is enforced
 * here — a pure function over the records — so every caller is held to it:
 * assignment, additional technicians, transfer and rescheduling all ask this
 * module rather than each re-deriving the rule, and the Calendar merely
 * displays what it already decided.
 *
 * GRANULARITY: jobs are scheduled by DATE in this system, not by time of day.
 * A part-day absence therefore conflicts with any job scheduled that day — the
 * safe direction, since the office cannot know from the record alone that the
 * 10:00 job would have finished before an 11:00 return. The times are carried
 * into the message so the Master can see exactly what the clash is and decide.
 */
export interface AvailabilityConflict {
  readonly record: AvailabilityRecord;
  /** The days the job and the absence share. */
  readonly overlappingDates: readonly IsoDate[];
}

const datesBetween = (start: IsoDate, end: IsoDate): readonly IsoDate[] => {
  const dates: IsoDate[] = [];
  const cursor = new Date(`${start}T00:00:00.000Z`);
  const last = new Date(`${end}T00:00:00.000Z`);
  while (cursor.getTime() <= last.getTime()) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
};

const overlaps = (
  aStart: IsoDate,
  aEnd: IsoDate,
  bStart: IsoDate,
  bEnd: IsoDate,
): boolean => aStart <= bEnd && aEnd >= bStart;

/**
 * Every active absence for this technician that overlaps the given window.
 *
 * An unscheduled job (no date yet) can never conflict: there is nothing to
 * compare. It becomes checkable the moment it is given a date.
 */
export const findAvailabilityConflicts = (
  records: readonly AvailabilityRecord[],
  userId: string,
  window: { readonly start: IsoDate; readonly end: IsoDate } | null,
): readonly AvailabilityConflict[] => {
  if (window === null) return [];

  return records
    .filter((record) => record.userId === userId && isBlockingAvailability(record))
    .filter((record) => overlaps(record.startDate, record.endDate, window.start, window.end))
    .map((record) => ({
      record,
      overlappingDates: datesBetween(
        record.startDate > window.start ? record.startDate : window.start,
        record.endDate < window.end ? record.endDate : window.end,
      ),
    }));
};

/** The same check, for a job rather than a bare window. */
export const findJobAvailabilityConflicts = (
  records: readonly AvailabilityRecord[],
  userId: string,
  job: Pick<Job, 'scheduledDate' | 'scheduledEndDate' | 'jobType'>,
): readonly AvailabilityConflict[] =>
  findAvailabilityConflicts(records, userId, jobScheduleWindow(job));

const formatDate = (date: IsoDate): string => {
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  return `${Number(date.slice(8, 10))} ${months[Number(date.slice(5, 7)) - 1] ?? ''}`;
};

/**
 * The sentence the Master or technician reads when a clash is refused.
 *
 * Deliberately specific: "unavailable" on its own is not actionable, but
 * "unavailable from 09:00 to 11:00 on 17 September due to an appointment" tells
 * them whether to pick another technician or move the job.
 */
export const describeAvailabilityConflict = (
  conflict: AvailabilityConflict,
  technicianName: string,
): string => {
  const { record } = conflict;
  const when =
    record.startDate === record.endDate
      ? formatDate(record.startDate)
      : `${formatDate(record.startDate)} to ${formatDate(record.endDate)}`;
  const time =
    record.allDay || record.startTime === null || record.endTime === null
      ? 'all day'
      : `from ${record.startTime} to ${record.endTime}`;

  return `${technicianName} is unavailable ${time} on ${when} due to ${availabilityTypeLabel(record.type).toLowerCase()}.`;
};

/** A compact form for a list, e.g. "Appointment · 17 Sep · 09:00–11:00". */
export const summariseAvailability = (record: AvailabilityRecord): string =>
  [
    availabilityTypeLabel(record.type),
    record.startDate === record.endDate
      ? formatDate(record.startDate)
      : `${formatDate(record.startDate)} – ${formatDate(record.endDate)}`,
    availabilityTimeLabel(record),
  ].join(' · ');

/**
 * Jobs already scheduled inside a proposed absence.
 *
 * Used when a Master records an absence that clashes with work already booked.
 * Those jobs are NEVER changed automatically — they are listed so the Master
 * resolves them deliberately.
 */
export const jobsAffectedByAbsence = (
  jobs: readonly Job[],
  userId: string,
  absence: { readonly startDate: IsoDate; readonly endDate: IsoDate },
): readonly Job[] =>
  jobs.filter((job) => {
    if (job.status === 'closed' || job.status === 'cancelled') {
      return false;
    }
    const assigned =
      job.primaryTechnicianId === userId || job.additionalTechnicianIds.includes(userId as never);
    if (!assigned) return false;

    const window = jobScheduleWindow(job);
    if (window === null) return false;
    return overlaps(window.start, window.end, absence.startDate, absence.endDate);
  });
