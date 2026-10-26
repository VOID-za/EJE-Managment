import type { IsoDate, IsoDateTime, UserId } from './common';

/**
 * WHETHER SOMEBODY WAS AT WORK ON A DAY. ATTEND-1.
 *
 * One record per person per day — the register's own unique key, enforced in
 * the database (`attendance_user_date_key`) and by the operation, which UPDATES
 * the day's record rather than adding a second one. Changing a day from absent
 * to present is a correction of that record, and the audit trail keeps what it
 * said before.
 *
 * DELIBERATELY SEPARATE from two things it is easily confused with:
 *
 *   - PLANNED LEAVE (`AvailabilityRecord`) is what was ARRANGED; attendance is
 *     what HAPPENED. Somebody on approved leave who came in anyway was present,
 *     and somebody with no leave who did not arrive was absent. Neither record
 *     writes the other; the register shows the leave beside the person only so
 *     the office can see it.
 *   - JOB STATUS. Being present says nothing about any job, and no job's
 *     status reads or writes attendance.
 */
export type AttendanceStatus = 'present' | 'absent';

export const ATTENDANCE_STATUSES: readonly AttendanceStatus[] = ['present', 'absent'];

export interface AttendanceRecord {
  readonly id: string;
  readonly userId: UserId;
  readonly date: IsoDate;
  readonly status: AttendanceStatus;
  /** Optional context: "left at 12:00 for the clinic", "on site at Midrand". */
  readonly note: string;
  /** Who last recorded or corrected it, and when. The history is in the audit trail. */
  readonly recordedBy: UserId;
  readonly recordedAt: IsoDateTime;
}

/**
 * THE DAY'S COMMENT ON A TECHNICIAN'S TIMESHEET. TIMESHEET-1.
 *
 * The one part of a timesheet the system did not already hold. Hours come from
 * the labour lines on each job and the call-out from the job itself, so they
 * are never copied here — copying them would create a second record of the
 * same hours, which is how hours get counted twice. A comment belongs to a
 * person and a day, not to a job: "waited two hours for the crane" is about
 * the day.
 */
export interface TimesheetComment {
  readonly id: string;
  readonly userId: UserId;
  readonly date: IsoDate;
  readonly comment: string;
  readonly updatedBy: UserId;
  readonly updatedAt: IsoDateTime;
}

/** The longest useful comment or note. A paragraph, not a report. */
export const ATTENDANCE_NOTE_LIMIT = 500;
export const TIMESHEET_COMMENT_LIMIT = 1000;
