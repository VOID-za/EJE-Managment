import {
  ABSENCE_REASON_LABELS,
  ABSENCE_REASONS,
  asUserId,
  can,
  userFullName,
  type AttendanceRecord,
  type AttendanceSnapshot,
  type AttendanceSnapshotDay,
  type IsoDate,
  type IsoDateTime,
  type User,
} from '@/domain';
import { businessToday } from '@/lib/business-time';
import { attendanceMonthFileName, documentNameOf, isPayrollMonth, monthBounds, monthTitle } from '@/lib/payroll-files';
import { formatDayAndDate, weekdayOf } from '@/lib/timesheet-dates';
import type { OperationContext } from './context';
import { WorkflowError } from './errors';

/**
 * THE MONTHLY ATTENDANCE FORM. PAY-01 (29 October 2026): the same quality of
 * preview, print and PDF as the timesheet — the actual attendance document,
 * never a print of a screen.
 *
 * One row per day of the month: Present, Absent with its reason (ATT-01: Leave,
 * Sick Leave, Family Responsibility, IOD), or NOT RECORDED — nothing inferred.
 *
 * VERSIONS. Before the month is submitted it is the register as it stands.
 * Once submitted, the month as it stood is frozen in the submission; the
 * technician can no longer change those days. The office may still correct its
 * own register (ATTEND-1 — audited), and the VERSION IN FORCE is the register:
 * a submitted month whose register has since been corrected says so on the
 * form ("Corrected by the office after submission", with the days), and the
 * submitted version stays readable exactly as it was sent ('submitted').
 */

const refuse = (message: string, code: string, detail: string): WorkflowError =>
  new WorkflowError(message, [{ code, message: detail }]);

export interface AttendanceDocumentRow {
  readonly date: IsoDate;
  readonly weekday: string;
  /** Present, Absent, NOT RECORDED, or — for a day still to come — empty. */
  readonly status: string;
  readonly reason: string;
  readonly note: string;
  readonly recorded: boolean;
  readonly future: boolean;
}

export interface AttendanceDocument {
  readonly companyName: string;
  readonly technicianName: string;
  /** "JC ATTEN OCTOBER.pdf". */
  readonly fileName: string;
  readonly month: string;
  readonly monthLabel: string;
  readonly rows: readonly AttendanceDocumentRow[];
  readonly summary: {
    readonly present: number;
    readonly absent: number;
    readonly byReason: readonly { readonly label: string; readonly count: number }[];
    readonly notRecorded: number;
    readonly weekdaysNotRecorded: number;
  };
  readonly submittedAt: IsoDateTime | null;
  readonly submittedByName: string | null;
  /** "Draft — not submitted", "As submitted", "Corrected by the office after submission (2 days)". */
  readonly versionLabel: string;
  readonly inForce: boolean;
  /** Days the office changed after the month was submitted. */
  readonly changedAfterSubmission: readonly IsoDate[];
}

const daysOf = (month: string): IsoDate[] => {
  const { from, to } = monthBounds(month);
  const days: IsoDate[] = [];
  for (let at = Date.parse(`${from}T00:00:00Z`); at <= Date.parse(`${to}T00:00:00Z`); at += 86_400_000) {
    days.push(new Date(at).toISOString().slice(0, 10));
  }
  return days;
};

const isWeekday = (date: string): boolean => {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
};

/** The month as it stands in the register, as snapshot days. Pure. */
export const attendanceSnapshotDays = (
  month: string,
  records: readonly Pick<AttendanceRecord, 'date' | 'status' | 'absenceReason' | 'note'>[],
): AttendanceSnapshotDay[] => {
  const byDate = new Map(records.map((record) => [record.date, record]));
  return daysOf(month).map((date) => {
    const record = byDate.get(date);
    return {
      date,
      status: record?.status ?? null,
      absenceReason: record?.absenceReason ?? null,
      note: record?.note ?? '',
    };
  });
};

const sameDay = (a: AttendanceSnapshotDay, b: AttendanceSnapshotDay): boolean =>
  a.status === b.status && a.absenceReason === b.absenceReason && a.note === b.note;

/** Days whose register answer differs from the submitted one. Pure. */
export const attendanceChanges = (
  submitted: readonly AttendanceSnapshotDay[],
  current: readonly AttendanceSnapshotDay[],
): IsoDate[] => {
  const now = new Map(current.map((day) => [day.date, day]));
  return submitted.filter((day) => { const other = now.get(day.date); return other !== undefined && !sameDay(day, other); }).map((day) => day.date);
};

/** Weekdays up to `today` with no answer: what the technician is asked to confirm. */
export const unrecordedWeekdays = (days: readonly AttendanceSnapshotDay[], today: IsoDate): IsoDate[] =>
  days.filter((day) => day.status === null && day.date <= today && isWeekday(day.date)).map((day) => day.date);

export const assertMayReadAttendanceOf = (context: OperationContext, technicianId: string): void => {
  if (can(context.actor.role, 'attendance.manage') || can(context.actor.role, 'timesheets.viewAll')) return;
  if (context.actor.id === technicianId) return;
  throw refuse(
    'You can only open your own attendance.',
    'not_permitted',
    'The office reads every technician’s attendance; a technician reads their own.',
  );
};

export const findPayrollPerson = async (context: OperationContext, technicianId: string): Promise<User> => {
  const person = await context.repos.users.findById(asUserId(technicianId));
  if (person === null) throw refuse('That person is not a user of the system.', 'unknown_user', 'Choose a technician.');
  return person;
};

export const assertPayrollMonth = (month: string): void => {
  if (!isPayrollMonth(month)) throw refuse('That is not a month.', 'invalid_month', 'Give the month as YYYY-MM.');
};

/** The form's rows and summary from snapshot days. Pure. */
export const buildAttendanceRows = (
  days: readonly AttendanceSnapshotDay[],
  today: IsoDate,
): Pick<AttendanceDocument, 'rows' | 'summary'> => {
  const rows = days.map((day): AttendanceDocumentRow => {
    const future = day.date > today;
    return {
      date: day.date,
      weekday: weekdayOf(day.date),
      status: day.status === 'present' ? 'Present' : day.status === 'absent' ? 'Absent' : future ? '' : 'NOT RECORDED',
      reason:
        day.status !== 'absent' ? '' : day.absenceReason === null ? 'Reason not recorded' : ABSENCE_REASON_LABELS[day.absenceReason],
      note: day.note,
      recorded: day.status !== null,
      future,
    };
  });
  return {
    rows,
    summary: {
      present: days.filter((day) => day.status === 'present').length,
      absent: days.filter((day) => day.status === 'absent').length,
      byReason: [
        ...ABSENCE_REASONS.map((reason) => ({
          label: ABSENCE_REASON_LABELS[reason],
          count: days.filter((day) => day.status === 'absent' && day.absenceReason === reason).length,
        })),
        { label: 'Reason not recorded', count: days.filter((day) => day.status === 'absent' && day.absenceReason === null).length },
      ].filter((entry) => entry.count > 0),
      notRecorded: days.filter((day) => day.status === null && day.date <= today).length,
      weekdaysNotRecorded: unrecordedWeekdays(days, today).length,
    },
  };
};

/**
 * THE MONTH'S ATTENDANCE FORM. 'current' — the version in force (the register);
 * 'submitted' — exactly what was submitted (refused for a month not submitted).
 */
export const loadAttendanceDocument = async (
  context: OperationContext,
  technicianId: string,
  month: string,
  version: 'current' | 'submitted' = 'current',
): Promise<AttendanceDocument> => {
  assertMayReadAttendanceOf(context, technicianId);
  assertPayrollMonth(month);
  const person = await findPayrollPerson(context, technicianId);
  const { from, to } = monthBounds(month);
  const [records, submission, settings] = await Promise.all([
    context.repos.attendance.listRecords(from, to, person.id),
    context.repos.payroll.findSubmission(person.id, month),
    context.repos.settings.get(),
  ]);
  const today = businessToday(new Date(context.services.clock.now()));
  const current = attendanceSnapshotDays(month, records);
  if (version === 'submitted' && submission === null) {
    throw refuse('This month has not been submitted.', 'month_not_submitted', 'Only a submitted month has a submitted version.');
  }
  const changed = submission === null ? [] : attendanceChanges(submission.attendance.days, current);
  const days = version === 'submitted' && submission !== null ? submission.attendance.days : current;
  const submitter = submission === null ? null : await context.repos.users.findById(submission.submittedBy);
  return {
    companyName: settings.companyName,
    technicianName: version === 'submitted' && submission !== null ? submission.attendance.technicianName : userFullName(person),
    fileName: attendanceMonthFileName(documentNameOf(person), month),
    month,
    monthLabel: monthTitle(month),
    ...buildAttendanceRows(days, today),
    submittedAt: submission?.submittedAt ?? null,
    submittedByName: submitter === null ? null : userFullName(submitter),
    versionLabel:
      submission === null
        ? 'Draft — not submitted'
        : version === 'submitted'
          ? changed.length === 0 ? 'As submitted' : `As submitted — superseded: the office corrected ${changed.length} day${changed.length === 1 ? '' : 's'} afterwards`
          : changed.length === 0 ? 'As submitted' : `Corrected by the office after submission (${changed.length} day${changed.length === 1 ? '' : 's'}: ${changed.map(formatDayAndDate).join(', ')})`,
    inForce: version === 'current' || changed.length === 0,
    changedAfterSubmission: changed,
  };
};

/** The snapshot frozen into a monthly submission. */
export const attendanceSnapshotFor = async (
  context: OperationContext,
  person: User,
  month: string,
): Promise<AttendanceSnapshot> => {
  const { from, to } = monthBounds(month);
  const records = await context.repos.attendance.listRecords(from, to, person.id);
  return { technicianName: userFullName(person), month, days: attendanceSnapshotDays(month, records) };
};
