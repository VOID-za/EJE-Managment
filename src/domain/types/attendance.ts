import type { CustomerId, IsoDate, IsoDateTime, UserId } from './common';

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

/**
 * ONE LINE OF A TECHNICIAN'S OWN TIMESHEET. TIMESHEET-2, the owner's
 * instruction of 27 October 2026: timesheets are COMPLETELY MANUAL.
 *
 * The technician types every value — the customer they worked for, the normal
 * time, overtime, double time and call-outs — for the day, as it happens or
 * all at once later (the morning of payday). Nothing is read from job cards,
 * assignments, labour lines or call-out flags, and nothing is ever prefilled,
 * recalculated or overwritten by the system.
 *
 * A day may have several lines (two customers in one day). A day with NO line
 * is unrecorded; a line of zeros is a recorded day with no hours — the two are
 * different facts and every screen and export keeps them apart.
 */
export interface TimesheetEntry {
  readonly id: string;
  /** Whose timesheet this line is on. Always the technician who wrote it. */
  readonly userId: UserId;
  readonly date: IsoDate;
  /** The register's customer, when the technician chose one from the list. */
  readonly customerId: CustomerId | null;
  /** The customer as the technician named it. Required when any value is above zero. */
  readonly customerName: string;
  readonly normalHours: number;
  readonly overtimeHours: number;
  readonly doubleHours: number;
  readonly callouts: number;
  readonly updatedBy: UserId;
  readonly updatedAt: IsoDateTime;
}

export const TIMESHEET_CUSTOMER_LIMIT = 200;
export const TIMESHEET_MAX_HOURS_PER_DAY = 24;
export const TIMESHEET_MAX_CALLOUTS_PER_LINE = 10;
