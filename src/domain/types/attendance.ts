import type { Cents, CustomerId, IsoDate, IsoDateTime, UserId } from './common';

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

/**
 * WHY SOMEBODY WAS ABSENT. ATT-01, the reviewer's instruction of 28 October
 * 2026: exactly these four, chosen from a list whenever a day is recorded as
 * absent. Attendance only — a timesheet line has no absence reason.
 *
 * A day recorded absent BEFORE the reason existed has none (`null`) and keeps
 * none: nothing invents a reason for history. Recording or correcting an
 * absent day from now on requires one.
 */
export type AbsenceReason = 'leave' | 'sick_leave' | 'family_responsibility' | 'iod';

export const ABSENCE_REASONS: readonly AbsenceReason[] = [
  'leave',
  'sick_leave',
  'family_responsibility',
  'iod',
];

export const ABSENCE_REASON_LABELS: Readonly<Record<AbsenceReason, string>> = {
  leave: 'Leave',
  sick_leave: 'Sick Leave',
  family_responsibility: 'Family Responsibility',
  iod: 'IOD (Injury on Duty)',
};

export const isAbsenceReason = (value: unknown): value is AbsenceReason =>
  typeof value === 'string' && (ABSENCE_REASONS as readonly string[]).includes(value);

export interface AttendanceRecord {
  readonly id: string;
  readonly userId: UserId;
  readonly date: IsoDate;
  readonly status: AttendanceStatus;
  /**
   * ATT-01. Set exactly when the day is absent and was recorded after the
   * reason existed; null on a present day and on an absent day from before.
   */
  readonly absenceReason: AbsenceReason | null;
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
  /** The customer as the technician named it. Required when any value is above zero, unless Workshop. */
  readonly customerName: string;
  /**
   * TS-06. Work in EJE's own workshop, chosen from the list rather than typed
   * as a customer. Not a customer record: `customerId` is null and the name is
   * empty, so nothing customer-linked counts it as a customer.
   */
  readonly workshop: boolean;
  /**
   * NT. TS-07 (28 October 2026): no longer entered on a new line. A line
   * written before keeps the value it was given — it is shown as historical
   * and never moved into OT or DT.
   */
  readonly normalHours: number;
  readonly overtimeHours: number;
  readonly doubleHours: number;
  /**
   * The NUMBER of call-outs, as TIMESHEET-2 recorded it. TS-08 replaced it with
   * an amount; a line written before keeps its count, shown as historical.
   */
  readonly callouts: number;
  /** TS-08. The call-out as a rand amount for this line, in cents. */
  readonly calloutAmount: Cents;
  /**
   * TS-08. This call-out is shared with other jobs. Recorded as the
   * technician says it; the system does not divide the amount between jobs —
   * no allocation rule has been given.
   */
  readonly calloutShared: boolean;
  /** TS-09. Kilometres driven for EJE's own purposes, one decimal. */
  readonly internalKm: number;
  /** TS-09. Kilometres driven for the customer, one decimal. */
  readonly customerKm: number;
  readonly updatedBy: UserId;
  readonly updatedAt: IsoDateTime;
}

/**
 * ONE TECHNICIAN'S TIMESHEET FOR ONE MONTH. TS-02, TS-03, TS-10.
 *
 * The month is the timesheet the PDF Layout prints ("Month" in its heading),
 * so it is what carries the one comment for the whole timesheet and what is
 * sent to the office. A month with no row is a draft nobody has commented on.
 *
 * SENT TO THE OFFICE IS FINAL FOR THE TECHNICIAN. Once `submittedAt` is set the
 * technician can no longer add, correct or remove a line on any day of that
 * month, nor change the comment; the server refuses it on every path. The
 * office reads the submitted version — `snapshot` holds exactly the lines and
 * the comment as they were sent, so the record of what was submitted cannot be
 * changed by anything later. There is no reopening: no rule for it has been
 * given (see the requirements matrix).
 */
export interface TimesheetMonth {
  readonly id: string;
  readonly userId: UserId;
  /** YYYY-MM. */
  readonly month: string;
  readonly comment: string;
  readonly updatedBy: UserId;
  readonly updatedAt: IsoDateTime;
  readonly submittedAt: IsoDateTime | null;
  readonly submittedBy: UserId | null;
  readonly snapshot: TimesheetSubmissionSnapshot | null;
}

/** What was sent to the office, frozen. */
export interface TimesheetSubmissionSnapshot {
  readonly technicianName: string;
  readonly month: string;
  readonly comment: string;
  readonly entries: readonly TimesheetEntry[];
}

export const TIMESHEET_CUSTOMER_LIMIT = 200;
export const TIMESHEET_MAX_HOURS_PER_DAY = 24;
export const TIMESHEET_MAX_CALLOUTS_PER_LINE = 10;
/** R1 000 000 per line: a ceiling against a slipped finger, not a business rule. */
export const TIMESHEET_MAX_CALLOUT_CENTS = 100_000_000;
export const TIMESHEET_MAX_KM_PER_LINE = 10_000;
export const TIMESHEET_MONTH_COMMENT_LIMIT = 2000;
export const WORKSHOP_LABEL = 'Workshop';
