import { asUserId, completesTimesheet, userFullName, type IsoDate, type IsoDateTime, type MonthlySubmission } from '@/domain';
import { businessToday } from '@/lib/business-time';
import {
  attendanceMonthFileName,
  documentNameOf,
  monthBounds,
  monthTitle,
  timesheetMonthFileName,
} from '@/lib/payroll-files';
import { formatDayAndDate, formatPeriod } from '@/lib/timesheet-dates';
import type { OperationContext } from './context';
import { audit, notifyOffice } from './audit';
import { WorkflowError } from './errors';
import {
  assertMayReadAttendanceOf,
  assertPayrollMonth,
  attendanceChanges,
  attendanceSnapshotDays,
  attendanceSnapshotFor,
  findPayrollPerson,
  unrecordedWeekdays,
} from './attendance-document';
import { submitTimesheetPeriod, versionInForce } from './timesheets';

/**
 * A TECHNICIAN'S MONTHLY SUBMISSION. PAY-02 (29 October 2026).
 *
 * ONE submission per technician per month, carrying BOTH documents:
 *
 *   - the TIMESHEET for exactly that calendar month — a timesheet period like
 *     any other (TS-02…TS-16: sent once, its days read-only, corrections only
 *     through the office-decided correction). If that exact period was already
 *     sent, it is the one used; otherwise it is sent now. A month that shares a
 *     day with a different sent period cannot be submitted — no work is ever
 *     sent twice — and the refusal names the period;
 *   - the ATTENDANCE for the month, frozen as it stood (the technician can no
 *     longer change those days; the office may still correct its register,
 *     audited, and that correction is what the forms then show — see
 *     `attendance-document.ts`).
 *
 * COMPLETE BEFORE IT GOES: the month must have ended (its last day may be
 * today); every absent day must carry a reason (ATT-01 — an absent day from
 * before the reasons existed has to be recorded again first); a weekday with
 * no attendance answer must be confirmed by the technician (they may truly
 * have none — a public holiday — but it is never sent unnoticed). Submitted
 * once: a retry, a double tap or a second tab gets one submission and one
 * refusal. The office is notified, once, after it is saved; it is audited.
 *
 * A COORDINATOR'S MONTH IS ATTENDANCE ONLY (TS-ROLE-1, the tester, 1 November
 * 2026): Coordinators keep no timesheet, so their submission carries the
 * attendance alone (`timesheetPeriodId` null — migration 0043 allows that for
 * a Coordinator only). A month a Coordinator already submitted WITH a
 * timesheet keeps it: history is never rewritten.
 */

const refuse = (message: string, code: string, detail: string): WorkflowError =>
  new WorkflowError(message, [{ code, message: detail }]);

export interface MonthlyFormsState {
  readonly technician: { readonly id: string; readonly name: string; readonly documentName: string };
  readonly month: string;
  readonly monthLabel: string;
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly monthEnded: boolean;
  readonly fileNames: { readonly timesheet: string; readonly attendance: string };
  /**
   * TS-ROLE-1. False for a Coordinator's month (attendance only) — unless that
   * month was already submitted with a timesheet, which it then still shows.
   */
  readonly timesheetRequired: boolean;
  readonly submission: { readonly submittedAt: IsoDateTime; readonly submittedByName: string | null } | null;
  readonly timesheet: {
    /** The exact month period was already sent (alone, or with the submission). */
    readonly sent: boolean;
    readonly versionInForce: string;
    readonly correctionPending: boolean;
    /** Sent periods sharing days with the month but not the month itself: they block the submission. */
    readonly blockingPeriods: readonly string[];
  };
  readonly attendance: {
    readonly unrecordedWeekdays: readonly IsoDate[];
    readonly absentWithoutReason: readonly IsoDate[];
    readonly changedAfterSubmission: readonly IsoDate[];
  };
  /** Plain sentences: what stops the month being submitted right now. */
  readonly problems: readonly string[];
  readonly canSubmit: boolean;
  /** Whether the person reading it is the technician (only they submit). */
  readonly owner: boolean;
}

/** The month's two documents, and whether they can be submitted. Read-only. */
export const loadMonthlyForms = async (
  context: OperationContext,
  technicianId: string,
  month: string,
): Promise<MonthlyFormsState> => {
  assertMayReadAttendanceOf(context, technicianId);
  assertPayrollMonth(month);
  const person = await findPayrollPerson(context, technicianId);
  const { from, to } = monthBounds(month);
  const today = businessToday(new Date(context.services.clock.now()));
  const [submission, period, sent, records] = await Promise.all([
    context.repos.payroll.findSubmission(person.id, month),
    context.repos.attendance.findPeriod(person.id, from, to),
    context.repos.attendance.listSubmittedPeriods(person.id, from, to),
    context.repos.attendance.listRecords(from, to, person.id),
  ]);
  const days = attendanceSnapshotDays(month, records);
  const timesheetRequired = submission === null ? completesTimesheet(person.role) : submission.timesheetPeriodId !== null;
  const exactSent = timesheetRequired && period !== null && period.submittedAt !== null ? period : null;
  const corrections = exactSent === null ? [] : await context.repos.attendance.listCorrections(exactSent.id);
  const blocking = timesheetRequired ? sent.filter((other) => exactSent === null || other.id !== exactSent.id) : [];
  const submitter = submission === null ? null : await context.repos.users.findById(submission.submittedBy);
  const missingReasons = days.filter((day) => day.status === 'absent' && day.absenceReason === null).map((day) => day.date);
  const unrecorded = unrecordedWeekdays(days, today);

  // MONTH-END-OFF-1 (2 November 2026): a month may be saved and submitted
  // before it ends, by every role. Submitting again later replaces it.
  const problems: string[] = [];
  // TS-OVERLAP-1: an earlier overlapping submission is not a problem — submitting replaces it.
  if (missingReasons.length > 0) {
    problems.push(`Give the absence reason for ${missingReasons.map(formatDayAndDate).join(', ')} (Attendance).`);
  }
  return {
    technician: { id: person.id, name: userFullName(person), documentName: documentNameOf(person) },
    month,
    monthLabel: monthTitle(month),
    from,
    to,
    monthEnded: to <= today,
    fileNames: {
      timesheet: timesheetMonthFileName(documentNameOf(person), month),
      attendance: attendanceMonthFileName(documentNameOf(person), month),
    },
    timesheetRequired,
    submission: submission === null ? null : { submittedAt: submission.submittedAt, submittedByName: submitter === null ? null : userFullName(submitter) },
    timesheet: {
      sent: exactSent !== null,
      versionInForce:
        !timesheetRequired ? 'Not required — the Office keeps no timesheet' :
        exactSent === null ? 'Not sent yet' : versionInForce(exactSent, corrections).correction === null ? 'Original submission' : `Correction ${versionInForce(exactSent, corrections).correction!.sequence} accepted`,
      correctionPending: corrections.some((correction) => correction.status === 'pending'),
      blockingPeriods: blocking.map((other) => formatPeriod(other.from, other.to)),
    },
    attendance: {
      unrecordedWeekdays: unrecorded,
      absentWithoutReason: missingReasons,
      changedAfterSubmission: submission === null ? [] : attendanceChanges(submission.attendance.days, days),
    },
    problems,
    canSubmit: problems.length === 0 && context.actor.id === person.id,
    owner: context.actor.id === person.id,
  };
};

/**
 * SUBMIT THE MONTH: the timesheet and the attendance together, once — or, for
 * a Coordinator, the attendance alone (TS-ROLE-1).
 * `confirmUnrecorded` must be true when weekdays have no attendance answer.
 */
export const submitMonth = async (
  context: OperationContext,
  technicianId: string,
  month: string,
  options: { readonly confirmUnrecorded?: boolean | undefined } = {},
): Promise<MonthlySubmission> => {
  const id = asUserId(technicianId);
  if (context.actor.id !== id) {
    throw refuse('You can only submit your own month.', 'not_permitted', 'Each person submits their own month; nobody submits another person’s attendance or timesheet.');
  }
  const state = await loadMonthlyForms(context, technicianId, month);
  // TS-OVERLAP-1 (3 November 2026): an overlapping earlier submission no longer blocks the month; sending replaces it.
  if (state.attendance.absentWithoutReason.length > 0) {
    throw refuse(
      'An absent day has no reason.',
      'absence_reason_required',
      `Give the reason for ${state.attendance.absentWithoutReason.map(formatDayAndDate).join(', ')} first.`,
    );
  }
  if (state.attendance.unrecordedWeekdays.length > 0 && options.confirmUnrecorded !== true) {
    throw refuse(
      `${state.attendance.unrecordedWeekdays.length} weekday${state.attendance.unrecordedWeekdays.length === 1 ? ' has' : 's have'} no attendance recorded.`,
      'attendance_incomplete',
      `${state.attendance.unrecordedWeekdays.map(formatDayAndDate).join(', ')}. Record them, or confirm they are right as they are.`,
    );
  }

  const person = await findPayrollPerson(context, technicianId);
  // The timesheet half: the exact month period, sent now unless it already
  // was. None for a Coordinator (TS-ROLE-1).
  /*
   * SUBMITTED AGAIN: THE NEW SUBMISSION REPLACES THE LAST ONE. RESUBMIT-1 (the
   * tester, 2 November 2026). The same row is rewritten with the month as it
   * stands now — no earlier copy, PDF or history of it is kept — and the
   * timesheet half is sent again with it. The attendance and timesheet lines
   * themselves are not touched.
   */
  const previous = await context.repos.payroll.findSubmission(person.id, month);
  let period = state.timesheetRequired ? await context.repos.attendance.findPeriod(person.id, state.from, state.to) : null;
  if (state.timesheetRequired && (period === null || period.submittedAt === null || previous !== null)) {
    period = await submitTimesheetPeriod(context, technicianId, state.from, state.to, { notify: false });
  }
  const now = context.services.clock.now();
  const next = {
    id: previous?.id ?? context.services.ids.next('msb'),
    userId: person.id,
    month,
    timesheetPeriodId: period?.id ?? null,
    attendance: await attendanceSnapshotFor(context, person, month),
    submittedAt: now,
    submittedBy: context.actor.id,
  };
  const saved = previous === null ? await context.repos.payroll.createSubmission(next) : await context.repos.payroll.replaceSubmission(next);
  if (saved === null) {
    throw refuse(`${state.monthLabel} has already been submitted to the office.`, 'month_submitted', 'It was submitted once; the office has it.');
  }
  const name = userFullName(person);
  const documents = state.timesheetRequired
    ? `Timesheet (${state.fileNames.timesheet}) and attendance (${state.fileNames.attendance})`
    : `Attendance (${state.fileNames.attendance}) — no timesheet: the Office keeps none —`;
  await audit(context, {
    jobId: null,
    type: 'monthly_forms_submitted',
    summary: `Monthly forms submitted: ${name}, ${state.monthLabel}`,
    detail:
      `${documents} sent to the office by ${userFullName(context.actor)}.` +
      (state.attendance.unrecordedWeekdays.length > 0
        ? ` Confirmed with ${state.attendance.unrecordedWeekdays.length} weekday(s) without attendance: ${state.attendance.unrecordedWeekdays.join(', ')}.`
        : ''),
  });
  await notifyOffice(context, {
    type: 'timesheet_submitted',
    title: `${name} submitted ${state.monthLabel}: ${state.timesheetRequired ? 'timesheet and attendance' : 'attendance'}`,
    body: state.timesheetRequired
      ? `${state.fileNames.timesheet} and ${state.fileNames.attendance}. Open Monthly payroll to include them in the Finance package.`
      : `${state.fileNames.attendance}. Open Monthly payroll to include it in the Finance package.`,
    link: '/payroll',
  });
  return saved;
};

/** True when the technician's own attendance for this day is frozen by a monthly submission. */
export const attendanceDayFrozen = async (context: OperationContext, userId: string, date: string): Promise<MonthlySubmission | null> =>
  context.repos.payroll.findSubmission(asUserId(userId), date.slice(0, 7));

/** One month in a person's monthly form history. */
export interface MonthlyHistoryEntry {
  readonly month: string;
  readonly monthLabel: string;
  readonly submittedAt: IsoDateTime;
  readonly submittedByName: string | null;
  readonly fileNames: { readonly timesheet: string; readonly attendance: string };
  /** False for a month submitted as attendance only (a Coordinator's, TS-ROLE-1). */
  readonly timesheetIncluded: boolean;
}

/**
 * A PERSON'S MONTHLY FORM HISTORY. My Monthly Forms (the tester, 30 October
 * 2026): every month they submitted, newest first, with the files it carried.
 * Their own, or the office's view of anybody's — the same rule as the forms.
 */
export const loadMonthlyHistory = async (context: OperationContext, userId: string): Promise<readonly MonthlyHistoryEntry[]> => {
  assertMayReadAttendanceOf(context, userId);
  const person = await findPayrollPerson(context, userId);
  const submissions = await context.repos.payroll.listSubmissionsFor(person.id);
  const names = new Map<string, string | null>();
  for (const submission of submissions) {
    if (!names.has(submission.submittedBy)) {
      const by = await context.repos.users.findById(submission.submittedBy);
      names.set(submission.submittedBy, by === null ? null : userFullName(by));
    }
  }
  return submissions.map((submission) => ({
    month: submission.month,
    monthLabel: monthTitle(submission.month),
    submittedAt: submission.submittedAt,
    submittedByName: names.get(submission.submittedBy) ?? null,
    fileNames: {
      timesheet: timesheetMonthFileName(documentNameOf(person), submission.month),
      attendance: attendanceMonthFileName(documentNameOf(person), submission.month),
    },
    timesheetIncluded: submission.timesheetPeriodId !== null,
  }));
};
