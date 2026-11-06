import {
  PAYROLL_PERIOD_MAX_DAYS,
  asUserId,
  can,
  completesTimesheet,
  userFullName,
  type AttendancePeriodSnapshot,
  type AttendanceSnapshotDay,
  type IsoDate,
  type IsoDateTime,
  type MonthlySubmission,
  type PayrollDocumentKind,
  type PayrollSubmission,
  type PayrollSubmissionDocument,
  type TimesheetPeriod,
  type User,
  type UserId,
} from '@/domain';
import { businessToday } from '@/lib/business-time';
import { sha256Hex } from '@/lib/job-card/document-identity';
import {
  attendancePeriodFileName,
  documentNameOf,
  monthBounds,
  monthTitle,
  monthsOfPeriod,
  periodTitle,
  timesheetPeriodFileName,
} from '@/lib/payroll-files';
import { normalisePdfFileName, sameFileName } from '@/lib/pdf-file-name';
import { formatDayAndDate, formatPeriod, isTimesheetDay } from '@/lib/timesheet-dates';
import { renderAttendancePdf } from '@/services/simulated/attendance-pdf';
import { OnePageOverflow } from '@/services/simulated/one-page-form';
import { renderTimesheetPdf } from '@/services/simulated/timesheet-pdf';
import type { OperationContext } from './context';
import { audit, notifyOffice } from './audit';
import { WorkflowError } from './errors';
import {
  assertMayReadAttendanceOf,
  attendanceSnapshotDays,
  buildAttendanceRows,
  findPayrollPerson,
  unrecordedWeekdays,
  type AttendanceDocument,
} from './attendance-document';
import { loadWorkingLines, type WorkingTimesheetLine } from './timesheet-lines';
import { loadTimesheetDocument, submitTimesheetPeriod, type TimesheetDocument } from './timesheets';

/**
 * MY MONTHLY FORMS — THE ONE PLACE PAYROLL IS SUBMITTED. PAYROLL-ONE-1 (the
 * owner, 5 November 2026; docs/payroll-forms.md).
 *
 * A person works on their Timesheet and their Attendance (both save
 * themselves, neither has a Submit), then opens My Monthly Forms, chooses the
 * From and To of their pay period — any days, across months and years — and
 * submits BOTH forms TOGETHER for exactly those dates:
 *
 *  1. The forms are read from the server as they stand (never a screen's
 *     copy), and the screen must have been showing exactly that: the request
 *     names the REVISION it reviewed, and a form changed since — another tab,
 *     a line still saving — is refused (`payroll_forms_changed`), never
 *     submitted unseen.
 *  2. Everything that would make the submission wrong is refused BEFORE
 *     anything is written: a timesheet line not complete yet (named, with
 *     what it needs), an absent day without its reason, weekdays with no
 *     attendance (unless confirmed), a timesheet with no lines (unless
 *     confirmed), dates covering only PART of an earlier submission (refused,
 *     naming it — never trimmed or merged), a corrected timesheet in the way,
 *     and a COMPLETE replacement not confirmed.
 *  3. Then, in the request's ONE database transaction: the timesheet is
 *     submitted for From–To (`submitTimesheetPeriod`: its snapshot, corrections
 *     and replacement rules unchanged), every earlier submission these dates
 *     cover in full is marked replaced (kept exactly as it was, linked to its
 *     replacement), the attendance is frozen, both PDFs are rendered and
 *     stored under keys the server makes, and ONE payroll submission records
 *     it all — the Finance month (the month of To), whether a timesheet was
 *     required, the names the PDFs went under. If any step fails, none of it
 *     is kept (PostgreSQL). The database refuses two current submissions of
 *     one person sharing a day, so two racing requests make one submission.
 *     A replayed request is answered from the idempotency store.
 *  4. The office is told, once, after it is saved.
 *
 * A PERSON WHO KEEPS NO TIMESHEET (the Office — `completesTimesheet`, the
 * existing role rule, TS-ROLE-1) submits attendance alone: recorded as
 * `timesheetRequired: false`, never an empty timesheet. Everybody else's
 * timesheet is required; one with no lines is submitted only when they
 * confirm it had none.
 *
 * In the demonstration's in-memory store there is no transaction: every check
 * is made before the first write, so only an unexpected failure part-way could
 * leave part of it — the production database never can.
 */

const refuse = (message: string, code: string, detail: string): WorkflowError =>
  new WorkflowError(message, [{ code, message: detail }]);

const addDays = (iso: string, days: number): IsoDate =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

const spanDays = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

/** The Finance month of a period: the calendar month holding its To (the owner, 5 November 2026). */
export const financeMonthOf = (to: string): string => to.slice(0, 7);

/** A From–To a payroll submission can cover: real days, From on or before To, at most a year. */
export const assertPayrollPeriod = (from: string, to: string): void => {
  if (!isTimesheetDay(from) || !isTimesheetDay(to)) {
    throw refuse('That is not a period.', 'invalid_date', 'Give From and To as real days (YYYY-MM-DD).');
  }
  if (from > to) throw refuse('The period ends before it starts.', 'invalid_range', 'Choose a From on or before the To.');
  if (spanDays(from, to) > PAYROLL_PERIOD_MAX_DAYS) {
    throw refuse('That period is longer than a year.', 'range_too_long', `Choose at most ${PAYROLL_PERIOD_MAX_DAYS} days.`);
  }
};

/** Every day From…To as attendance snapshot days, across months and years. Pure. */
export const attendancePeriodDays = (
  from: string,
  to: string,
  records: Parameters<typeof attendanceSnapshotDays>[1],
): AttendanceSnapshotDay[] =>
  monthsOfPeriod(from, to).flatMap((month) => attendanceSnapshotDays(month, records).filter((day) => day.date >= from && day.date <= to));

const monthRange = (month: string) => monthBounds(month);

/** What an earlier submission is to these dates: not in the way, covered in full (replaced), or cut (refused). */
export const relation = (from: string, to: string, other: { readonly from: string; readonly to: string }): 'apart' | 'covered' | 'partial' =>
  other.to < from || other.from > to ? 'apart' : from <= other.from && other.to <= to ? 'covered' : 'partial';

export interface PayrollOverlap {
  readonly kind: 'payroll' | 'monthly' | 'timesheet';
  readonly id: string;
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly label: string;
}

export interface PayrollFormsState {
  readonly technician: { readonly id: UserId; readonly name: string; readonly documentName: string };
  readonly owner: boolean;
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly periodLabel: string;
  readonly days: number;
  /** The month of To: the month whose Finance package carries it. */
  readonly financeMonth: string;
  readonly financeMonthLabel: string;
  readonly timesheetRequired: boolean;
  /** The names the two PDFs have now — the person's own, or the default. */
  readonly fileNames: { readonly timesheet: string; readonly attendance: string };
  readonly customNames: { readonly timesheet: boolean; readonly attendance: boolean };
  readonly defaultNames: { readonly timesheet: string; readonly attendance: string };
  readonly timesheet: {
    readonly lineCount: number;
    readonly totals: { readonly overtimeHours: number; readonly doubleHours: number; readonly calloutAmount: number; readonly internalKm: number; readonly customerKm: number };
    /** Lines in the dates that are not complete yet: they block the submission. */
    readonly incomplete: readonly { readonly id: string; readonly date: IsoDate | null; readonly problems: readonly string[] }[];
    readonly comment: string;
  } | null;
  readonly attendance: {
    readonly present: number;
    readonly absent: number;
    readonly recorded: number;
    readonly unrecordedWeekdays: readonly IsoDate[];
    readonly absentWithoutReason: readonly IsoDate[];
  };
  /** Earlier submissions these dates cut: they block the submission. */
  readonly partialOverlaps: readonly PayrollOverlap[];
  /** Earlier submissions these dates cover in full: submitting replaces them, once confirmed. */
  readonly replaces: readonly PayrollOverlap[];
  /** A corrected timesheet in the way: it cannot be replaced. */
  readonly correctedInTheWay: readonly PayrollOverlap[];
  /** Plain sentences: what stops the submission now. */
  readonly problems: readonly string[];
  readonly needs: { readonly confirmUnrecorded: boolean; readonly confirmNoLines: boolean; readonly confirmReplace: boolean };
  readonly canSubmit: boolean;
  /** What the screen reviewed; the submission must name it. */
  readonly revision: string;
  /** The dates the page proposes: the day after the last submission, to today. */
  readonly suggested: { readonly from: IsoDate; readonly to: IsoDate };
}

const assertOwnForms = (context: OperationContext, userId: UserId): void => {
  if (context.actor.id === userId) return;
  throw refuse(
    'You can only change your own monthly forms.',
    'not_permitted',
    'Each person renames and submits their own forms; the office reads them.',
  );
};

/** Names the person gave their working PDFs, or the defaults for these dates. */
export const namesFor = async (context: OperationContext, person: User, from: string, to: string) => {
  const stored = await context.repos.payroll.listDocumentNames(person.id);
  const custom = (kind: PayrollDocumentKind) => stored.find((name) => name.kind === kind)?.fileName ?? null;
  const defaults = {
    timesheet: timesheetPeriodFileName(documentNameOf(person), from, to),
    attendance: attendancePeriodFileName(documentNameOf(person), from, to),
  };
  return {
    defaults,
    custom: { timesheet: custom('timesheet') !== null, attendance: custom('attendance') !== null },
    names: { timesheet: custom('timesheet') ?? defaults.timesheet, attendance: custom('attendance') ?? defaults.attendance },
  };
};

/** The person's current submissions of every kind — the ones that can be in the way of new dates. */
export const currentSubmissions = async (context: OperationContext, person: User) => {
  const [payroll, monthly, periods] = await Promise.all([
    context.repos.payroll.listPayrollSubmissionsFor(person.id),
    context.repos.payroll.listSubmissionsFor(person.id),
    context.repos.attendance.listSubmissions(person.id),
  ]);
  return {
    payroll: payroll.filter((submission) => (submission.supersededAt ?? null) === null),
    monthly: monthly.filter((submission) => (submission.supersededAt ?? null) === null),
    periods: periods.filter((period) => (period.supersededAt ?? null) === null),
  };
};

const overlapOf = (kind: PayrollOverlap['kind'], id: string, from: string, to: string): PayrollOverlap => ({
  kind,
  id,
  from,
  to,
  label: `${kind === 'monthly' ? 'monthly forms' : kind === 'timesheet' ? 'timesheet' : 'forms'} ${formatPeriod(from, to)}`,
});

/** THE FORMS FOR A PERIOD, AND WHETHER THEY CAN BE SUBMITTED. Read-only. */
export const loadPayrollForms = async (
  context: OperationContext,
  technicianId: string,
  from: string,
  to: string,
): Promise<PayrollFormsState> => {
  assertMayReadAttendanceOf(context, technicianId);
  assertPayrollPeriod(from, to);
  const person = await findPayrollPerson(context, technicianId);
  const timesheetRequired = completesTimesheet(person.role);
  const today = businessToday(new Date(context.services.clock.now()));
  const owner = context.actor.id === person.id;
  const [records, names, current, working] = await Promise.all([
    context.repos.attendance.listRecords(from, to, person.id),
    namesFor(context, person, from, to),
    currentSubmissions(context, person),
    timesheetRequired ? context.repos.attendance.findWorkingComment(person.id) : Promise.resolve(null),
  ]);
  // The office reads anybody's lines; the person reads their own (only a role that keeps a timesheet has any).
  const lines: readonly WorkingTimesheetLine[] = timesheetRequired ? await loadWorkingLines(context, person.id) : [];
  const within = (date: string | null | undefined) => date != null && from <= date && date <= to;
  const inDates = lines.filter((line) => within(line.date));
  // A stored line being moved by a draft is in these dates by EITHER date: its stored copy would be frozen by them.
  const touching = lines.filter((line) => within(line.date) || within(line.entry?.date));
  // A draft with no date could be meant for any period: it is in the way of every submission.
  const incomplete = [...touching, ...lines.filter((line) => line.date === null && !within(line.entry?.date))].filter((line) => !line.complete);
  const complete = inDates.filter((line) => line.complete && line.entry !== null).map((line) => line.entry!);
  const sum = (pick: (entry: (typeof complete)[number]) => number) => complete.reduce((total, entry) => total + pick(entry), 0);

  const days = attendancePeriodDays(from, to, records);
  const unrecorded = unrecordedWeekdays(days, today);
  const absentWithoutReason = days.filter((day) => day.status === 'absent' && day.absenceReason === null).map((day) => day.date);

  const partialOverlaps: PayrollOverlap[] = [];
  const replaces: PayrollOverlap[] = [];
  const correctedInTheWay: PayrollOverlap[] = [];
  const sort = (overlap: PayrollOverlap, how: ReturnType<typeof relation>) => {
    if (how === 'partial') partialOverlaps.push(overlap);
    else if (how === 'covered') replaces.push(overlap);
  };
  for (const submission of current.payroll) sort(overlapOf('payroll', submission.id, submission.from, submission.to), relation(from, to, submission));
  for (const submission of current.monthly) {
    const bounds = monthRange(submission.month);
    sort(overlapOf('monthly', submission.id, bounds.from, bounds.to), relation(from, to, bounds));
  }
  // The timesheet half follows the timesheet rules (TS-PAPER-7): a corrected one is never replaced from the lines.
  const ownPeriodOf = new Set(current.payroll.map((submission) => submission.timesheetPeriodId).filter((id) => id !== null));
  if (timesheetRequired) {
    for (const period of current.periods) {
      const how = relation(from, to, period);
      if (how === 'apart') continue;
      const overlap = overlapOf('timesheet', period.id, period.from, period.to);
      if ((await context.repos.attendance.listCorrections(period.id)).length > 0) correctedInTheWay.push(overlap);
      // A timesheet that is the half of a payroll submission listed above is not named twice.
      else if (!ownPeriodOf.has(period.id)) sort(overlap, how);
    }
  }

  const problems: string[] = [];
  /*
   * NEVER THE SAME DAYS TO FINANCE TWICE (the review of 5 November 2026). A
   * submission already in a SENT Finance package may be replaced only by one
   * for the same Finance month — that package then goes again marked
   * CORRECTED. Replaced by dates ending in another month, its days would reach
   * Finance a second time, unmarked; refused, naming the package.
   */
  for (const overlap of replaces) {
    const sentMonth = overlap.kind === 'monthly' ? overlap.from.slice(0, 7) : financeMonthOf(overlap.to);
    if (sentMonth === financeMonthOf(to)) continue;
    const packages = await context.repos.payroll.listPackages(sentMonth);
    const sent = packages.find((item) => item.status === 'sent' && item.attachments.some((attachment) => attachment.technicianId === person.id));
    if (sent !== undefined) {
      problems.push(
        `Your ${overlap.label} went to Finance in the ${monthTitle(sentMonth)} package on ${(sent.sentAt ?? '').slice(0, 10)}. ` +
          `A replacement ending in ${monthTitle(financeMonthOf(to))} would send those days again: choose dates ending in ${monthTitle(sentMonth)}, or ask the office.`,
      );
    }
  }
  // A person who keeps no timesheet now, but submitted one before for these days: the office decides, not a replacement.
  if (!timesheetRequired) {
    for (const period of current.periods) {
      if (relation(from, to, period) !== 'apart') {
        problems.push(`A timesheet was submitted for ${formatPeriod(period.from, period.to)}, when you kept one. Ask the office before submitting attendance only for these days.`);
      }
    }
  }
  for (const line of incomplete) {
    problems.push(`Timesheet line ${line.date === null ? 'with no date' : `on ${formatDayAndDate(line.date)}`} is not complete: ${line.problems.map((problem) => problem.message).join(' ')}`);
  }
  if (absentWithoutReason.length > 0) {
    problems.push(`Give the absence reason for ${absentWithoutReason.map(formatDayAndDate).join(', ')} (Attendance).`);
  }
  for (const overlap of partialOverlaps) {
    problems.push(`These dates cover only part of your submitted ${overlap.label}. Choose dates that start after it ends, or that cover all of it to replace it.`);
  }
  if (timesheetRequired && sameFileName(names.names.timesheet, names.names.attendance)) {
    problems.push(`Both PDFs are called “${names.names.timesheet}”. Rename one, so they cannot overwrite each other when saved.`);
  }
  for (const overlap of correctedInTheWay) {
    problems.push(`Your submitted ${overlap.label} has a correction, so it cannot be replaced. Choose dates that start after it ends.`);
  }
  const latest = [...current.payroll.map((submission) => submission.to), ...current.periods.map((period) => period.to), ...current.monthly.map((submission) => monthRange(submission.month).to)]
    .sort()
    .at(-1);
  const suggestedFrom = latest === undefined ? monthBounds(today.slice(0, 7)).from : addDays(latest, 1);

  const state = {
    technician: { id: person.id, name: userFullName(person), documentName: documentNameOf(person) },
    owner,
    from,
    to,
    periodLabel: formatPeriod(from, to),
    days: spanDays(from, to),
    financeMonth: financeMonthOf(to),
    financeMonthLabel: monthTitle(financeMonthOf(to)),
    timesheetRequired,
    fileNames: names.names,
    customNames: names.custom,
    defaultNames: names.defaults,
    timesheet: timesheetRequired
      ? {
          lineCount: complete.length,
          totals: {
            overtimeHours: Math.round(sum((entry) => entry.overtimeHours) * 100) / 100,
            doubleHours: Math.round(sum((entry) => entry.doubleHours) * 100) / 100,
            calloutAmount: sum((entry) => entry.calloutAmount),
            internalKm: Math.round(sum((entry) => entry.internalKm) * 10) / 10,
            customerKm: Math.round(sum((entry) => entry.customerKm) * 10) / 10,
          },
          incomplete: incomplete.map((line) => ({ id: line.id, date: line.date, problems: line.problems.map((problem) => problem.message) })),
          comment: working?.comment ?? '',
        }
      : null,
    attendance: {
      present: days.filter((day) => day.status === 'present').length,
      absent: days.filter((day) => day.status === 'absent').length,
      recorded: days.filter((day) => day.status !== null).length,
      unrecordedWeekdays: unrecorded,
      absentWithoutReason,
    },
    partialOverlaps,
    replaces,
    correctedInTheWay,
    problems,
    needs: {
      confirmUnrecorded: unrecorded.length > 0,
      confirmNoLines: timesheetRequired && complete.length === 0,
      confirmReplace: replaces.length > 0,
    },
    canSubmit: owner && problems.length === 0,
    suggested: { from: suggestedFrom, to: today >= suggestedFrom ? today : suggestedFrom },
  };
  // THE REVISION: everything the submission would freeze, and everything that decides whether it may.
  const revision = await sha256Hex(
    new TextEncoder().encode(
      JSON.stringify({
        from,
        to,
        lines: touching.map((line) => [line.id, line.revision, line.complete]),
        undated: lines.filter((line) => line.date === null).map((line) => [line.id, line.revision]),
        comment: state.timesheet?.comment ?? null,
        days,
        names: names.names,
        replaces: replaces.map((overlap) => overlap.id),
        partial: partialOverlaps.map((overlap) => overlap.id),
      }),
    ),
  );
  return { ...state, revision };
};

/** THE WORKING ATTENDANCE FOR A PERIOD, as its PDF prints it, under its stored name. */
export const workingAttendanceDocument = async (
  context: OperationContext,
  person: User,
  from: string,
  to: string,
  fileName: string,
): Promise<AttendanceDocument> => {
  const [records, settings] = await Promise.all([context.repos.attendance.listRecords(from, to, person.id), context.repos.settings.get()]);
  const today = businessToday(new Date(context.services.clock.now()));
  return {
    companyName: settings.companyName,
    technicianName: userFullName(person),
    fileName,
    month: financeMonthOf(to),
    monthLabel: periodTitle(from, to),
    ...buildAttendanceRows(attendancePeriodDays(from, to, records), today),
    submittedAt: null,
    submittedByName: null,
    versionLabel: 'Working copy — not submitted',
    inForce: true,
    changedAfterSubmission: [],
    period: { from, to },
  };
};

/**
 * ONE OF THE TWO WORKING DOCUMENTS FOR A PERIOD — what Preview, Print,
 * Download and Save PDF show — under the name the person gave it. The
 * timesheet is exactly what submitting these dates would freeze.
 */
export const loadPayrollFormDocument = async (
  context: OperationContext,
  technicianId: string,
  kind: PayrollDocumentKind,
  from: string,
  to: string,
): Promise<TimesheetDocument | AttendanceDocument> => {
  assertMayReadAttendanceOf(context, technicianId);
  assertPayrollPeriod(from, to);
  const person = await findPayrollPerson(context, technicianId);
  const names = await namesFor(context, person, from, to);
  if (kind === 'attendance') return workingAttendanceDocument(context, person, from, to, names.names.attendance);
  if (!completesTimesheet(person.role)) {
    throw refuse('This person keeps no timesheet.', 'timesheet_not_required', 'The Office submits attendance only.');
  }
  // The office reads anybody's; the owner their own (the timesheet's own rule decides).
  const document = await loadTimesheetDocument(context, person.id, from, to, 'working');
  return { ...document, fileName: names.names.timesheet, versionLabel: 'Working copy — not submitted' };
};

/**
 * RENAME A WORKING PDF. The person's own; stored as metadata (never a path),
 * checked by `normalisePdfFileName`, and different from the other form's
 * name. Kept until the forms are submitted. An empty name goes back to the
 * default. Renaming submits nothing, locks nothing and changes nothing in the
 * document.
 */
export const renamePayrollDocument = async (
  context: OperationContext,
  technicianId: string,
  kind: PayrollDocumentKind,
  requested: string,
): Promise<{ readonly fileName: string; readonly custom: boolean }> => {
  const userId = asUserId(technicianId);
  assertOwnForms(context, userId);
  if (kind !== 'timesheet' && kind !== 'attendance') throw refuse('That is not one of the forms.', 'invalid_kind', 'Timesheet or attendance.');
  const person = await findPayrollPerson(context, technicianId);
  if (kind === 'timesheet' && !completesTimesheet(person.role)) {
    throw refuse('You keep no timesheet.', 'timesheet_not_required', 'Only your attendance is submitted.');
  }
  const stored = await context.repos.payroll.listDocumentNames(userId);
  const before = stored.find((name) => name.kind === kind)?.fileName ?? null;
  if (requested.trim() === '') {
    if (before !== null) {
      await context.repos.payroll.deleteDocumentName(userId, kind);
      await audit(context, {
        jobId: null,
        type: 'payroll_document_renamed',
        summary: `${kind === 'timesheet' ? 'Timesheet' : 'Attendance'} PDF name back to the default: ${userFullName(person)}`,
        detail: `Was “${before}”.`,
        changes: [{ field: 'File name', from: before, to: '(default)' }],
      });
    }
    return { fileName: '', custom: false };
  }
  const checked = normalisePdfFileName(requested);
  if (!checked.ok) throw refuse('That file name cannot be used.', 'invalid_file_name', checked.problem);
  const other = stored.find((name) => name.kind !== kind)?.fileName ?? null;
  if (other !== null && sameFileName(other, checked.name)) {
    throw refuse(
      'Both forms would have the same file name.',
      'duplicate_file_name',
      `Your ${kind === 'timesheet' ? 'attendance' : 'timesheet'} PDF is already called “${other}”. Give each its own name, so they cannot overwrite each other when saved.`,
    );
  }
  if (before === checked.name) return { fileName: checked.name, custom: true };
  await context.repos.payroll.saveDocumentName({
    userId,
    kind,
    fileName: checked.name,
    updatedBy: context.actor.id,
    updatedAt: context.services.clock.now(),
  });
  await audit(context, {
    jobId: null,
    type: 'payroll_document_renamed',
    summary: `${kind === 'timesheet' ? 'Timesheet' : 'Attendance'} PDF renamed: ${userFullName(person)}`,
    detail: `Now “${checked.name}”. The working document only; nothing was submitted.`,
    changes: [{ field: 'File name', from: before ?? '(default)', to: checked.name }],
  });
  return { fileName: checked.name, custom: true };
};

export interface SubmitPayrollFormsInput {
  readonly from: string;
  readonly to: string;
  /** The revision the screen reviewed (`PayrollFormsState.revision`). */
  readonly revision: string;
  readonly confirmUnrecorded?: boolean | undefined;
  readonly confirmNoLines?: boolean | undefined;
  /** Required when the dates cover an earlier submission in full: it is replaced, and kept. */
  readonly confirmReplace?: boolean | undefined;
}

export const oneFormPage = <T extends { readonly pageCount: number }>(name: string, render: () => T): T => {
  try {
    const rendered = render();
    if (rendered.pageCount !== 1) throw refuse(`The ${name} is not one page.`, 'form_not_one_page', 'Every payroll form except a timesheet is one page.');
    return rendered;
  } catch (cause) {
    if (cause instanceof OnePageOverflow) {
      throw refuse(`The ${name} does not fit on one page.`, 'form_too_long_for_one_page', `${cause.message} Choose a shorter period.`);
    }
    throw cause;
  }
};

/** SUBMIT BOTH FORMS TOGETHER, for exactly From–To. See the module comment for every rule. */
export const submitPayrollForms = async (
  context: OperationContext,
  technicianId: string,
  input: SubmitPayrollFormsInput,
  /**
   * FORM-LIFECYCLE-1: the forms were COMPLETED on their own pages and are submitted as they were completed —
   * under the names chosen then, with the timesheet's comment as it was frozen. Everything about the lines and
   * the days was checked at completion, and their dates have been locked since; `submitCompletedForms` checks
   * that they are still exactly as completed before it calls this.
   */
  completed?: { readonly fileNames: { readonly timesheet: string; readonly attendance: string }; readonly timesheetComment: string },
): Promise<PayrollSubmission> => {
  const userId = asUserId(technicianId);
  if (context.actor.id !== userId) {
    throw refuse('You can only submit your own forms.', 'not_permitted', 'Each person submits their own timesheet and attendance; nobody submits another person’s.');
  }
  const { from, to } = input;
  const state = await loadPayrollForms(context, technicianId, from, to);
  if (state.revision !== input.revision) {
    throw refuse(
      'Your forms changed after you opened them.',
      'payroll_forms_changed',
      'They are shown again as they are now. Check them, then submit.',
    );
  }
  // A completed form was checked when it was completed; working lines elsewhere (a draft with no date) are not its.
  const incomplete = completed === undefined ? state.timesheet?.incomplete ?? [] : [];
  if (incomplete.length > 0) {
    throw refuse(
      `${incomplete.length} timesheet line${incomplete.length === 1 ? ' is' : 's are'} not complete.`,
      'timesheet_lines_incomplete',
      `${incomplete.map((line) => `${line.date === null ? 'A line with no date' : formatDayAndDate(line.date)}: ${line.problems.join(' ')}`).join(' · ')} Complete or remove ${incomplete.length === 1 ? 'it' : 'them'} on the Timesheets page.`,
    );
  }
  if (state.attendance.absentWithoutReason.length > 0) {
    throw refuse('An absent day has no reason.', 'absence_reason_required', `Give the reason for ${state.attendance.absentWithoutReason.map(formatDayAndDate).join(', ')} first.`);
  }
  if (state.partialOverlaps.length > 0) {
    const named = state.partialOverlaps.map((overlap) => overlap.label).join('; ');
    throw refuse(
      `These dates cover only part of your submitted ${named}.`,
      'payroll_partial_overlap',
      'The days left outside would fall out of payroll. Choose dates that start after it ends, or that cover all of it to replace it. Nothing was submitted.',
    );
  }
  if (state.correctedInTheWay.length > 0) {
    throw refuse(
      `Your submitted ${state.correctedInTheWay.map((overlap) => overlap.label).join('; ')} has a correction, so it cannot be replaced.`,
      'timesheet_replace_corrected',
      'Change it with another correction under Submitted timesheets on My Monthly Forms, or choose dates that start after it ends.',
    );
  }
  // Anything else the screen lists as stopping it (both PDFs named the same, days already sent to Finance, …).
  if (completed !== undefined && state.replaces.length > 0) {
    throw refuse('These dates were already submitted.', 'payroll_period_submitted', 'A completed form is never a replacement. Nothing was submitted.');
  }
  if (completed === undefined && state.problems.length > 0) {
    throw refuse('These forms cannot be submitted yet.', 'payroll_forms_blocked', state.problems.join(' '));
  }
  if (state.needs.confirmReplace && input.confirmReplace !== true) {
    throw refuse(
      `These dates would replace your submitted ${state.replaces.map((overlap) => overlap.label).join('; ')}.`,
      'payroll_replace_unconfirmed',
      'Confirm that this submission replaces it. The earlier one is kept exactly as it was submitted, marked replaced, and Finance uses only the new one.',
    );
  }
  if (state.needs.confirmUnrecorded && input.confirmUnrecorded !== true) {
    throw refuse(
      `${state.attendance.unrecordedWeekdays.length} weekday${state.attendance.unrecordedWeekdays.length === 1 ? ' has' : 's have'} no attendance recorded.`,
      'attendance_incomplete',
      `${state.attendance.unrecordedWeekdays.map(formatDayAndDate).join(', ')}. Record them, or confirm they are right as they are.`,
    );
  }
  if (state.needs.confirmNoLines && input.confirmNoLines !== true) {
    throw refuse(
      'Your timesheet has no lines for these dates.',
      'timesheet_empty_unconfirmed',
      'Add your lines on the Timesheets page, or confirm you have nothing to claim for these dates.',
    );
  }

  const person = await findPayrollPerson(context, technicianId);
  const [records, settings] = await Promise.all([context.repos.attendance.listRecords(from, to, person.id), context.repos.settings.get()]);
  const fileNames = completed?.fileNames ?? state.fileNames;
  const attendance: AttendancePeriodSnapshot = { technicianName: userFullName(person), from, to, days: attendancePeriodDays(from, to, records) };
  const today = businessToday(new Date(context.services.clock.now()));
  const attendanceDocumentAt = (submittedAt: IsoDateTime | null): AttendanceDocument => ({
    companyName: settings.companyName,
    technicianName: attendance.technicianName,
    fileName: fileNames.attendance,
    month: financeMonthOf(to),
    monthLabel: periodTitle(from, to),
    ...buildAttendanceRows(attendance.days, today),
    submittedAt,
    submittedByName: submittedAt === null ? null : userFullName(context.actor),
    versionLabel: submittedAt === null ? 'Working copy — not submitted' : 'As submitted',
    inForce: true,
    changedAfterSubmission: [],
    period: { from, to },
  });
  // Rendered once BEFORE anything is written: a form that cannot be printed is refused, not half-submitted.
  oneFormPage('attendance form', () => renderAttendancePdf(attendanceDocumentAt(null), { generatedAt: context.services.clock.now() }));

  const now = context.services.clock.now();
  const submissionId = context.services.ids.next('psb');
  let period: TimesheetPeriod | null = null;
  try {
    if (state.timesheetRequired) {
      period = await submitTimesheetPeriod(context, technicianId, from, to, {
        notify: false,
        ...(completed === undefined ? {} : { comment: completed.timesheetComment }),
        // Confirmed above whenever these dates cover an earlier submission in full.
        replace: input.confirmReplace === true,
        replaceSameDates: true,
      });
    }
    const replacedPayroll = await context.repos.payroll.replacePayrollSubmissions({
      userId,
      ids: state.replaces.filter((overlap) => overlap.kind === 'payroll').map((overlap) => overlap.id),
      at: now,
      by: context.actor.id,
      bySubmission: submissionId,
    });
    const replacedMonthly: readonly MonthlySubmission[] = await context.repos.payroll.replaceMonthlySubmissions({
      userId,
      ids: state.replaces.filter((overlap) => overlap.kind === 'monthly').map((overlap) => overlap.id),
      at: now,
      by: context.actor.id,
      bySubmission: submissionId,
    });

    // The documents as they went: rendered now, stored write-once under the server's own keys.
    const documents: PayrollSubmissionDocument[] = [];
    const store = async (kind: PayrollDocumentKind, fileName: string, rendered: { readonly bytes: Uint8Array; readonly pageCount: number }) => {
      const storageKey = `payroll-submissions/${submissionId}/${kind}.pdf`;
      await context.services.storage.putDocument({ storageKey, fileName, contentType: 'application/pdf', bytes: rendered.bytes, renderer: 1, backfilled: false });
      const back = await context.services.storage.getDocument(storageKey);
      if (back === null || back.bytes.byteLength !== rendered.bytes.byteLength) {
        throw refuse('A form could not be stored.', 'payroll_file_not_stored', 'Nothing was submitted. Try again.');
      }
      documents.push({ kind, fileName, storageKey, sha256: await sha256Hex(rendered.bytes), sizeBytes: rendered.bytes.byteLength, pageCount: rendered.pageCount });
    };
    if (period !== null) {
      const sheet = await loadTimesheetDocument(context, person.id, from, to, 'current');
      await store('timesheet', fileNames.timesheet, renderTimesheetPdf({ ...sheet, fileName: fileNames.timesheet }, { generatedAt: now }));
    }
    await store('attendance', fileNames.attendance, oneFormPage('attendance form', () => renderAttendancePdf(attendanceDocumentAt(now), { generatedAt: now })));

    const saved = await context.repos.payroll.createPayrollSubmission({
      id: submissionId,
      userId,
      from,
      to,
      financeMonth: financeMonthOf(to),
      timesheetRequired: state.timesheetRequired,
      timesheetPeriodId: period?.id ?? null,
      attendance,
      fileNames: { timesheet: state.timesheetRequired ? fileNames.timesheet : '', attendance: fileNames.attendance },
      documents,
      submittedAt: now,
      submittedBy: context.actor.id,
      supersededAt: null,
      supersededBy: null,
      supersededBySubmission: null,
    });
    if (saved === null) {
      throw refuse(`Your forms for ${formatPeriod(from, to)} were just submitted.`, 'payroll_already_submitted', 'They were submitted once; the office has them.');
    }
    // The working names were for this submission; the next forms start from the defaults (a completed form took its name with it).
    for (const kind of ['timesheet', 'attendance'] as const) {
      if (completed === undefined && state.customNames[kind]) await context.repos.payroll.deleteDocumentName(userId, kind);
    }

    const name = userFullName(person);
    const replacedText = [
      ...replacedPayroll.map((submission) => `forms ${formatPeriod(submission.from, submission.to)}`),
      ...replacedMonthly.map((submission) => `monthly forms ${monthTitle(submission.month)}`),
    ];
    await audit(context, {
      jobId: null,
      type: 'payroll_forms_submitted',
      summary: `Payroll forms submitted: ${name}, ${formatPeriod(from, to)} (Finance ${monthTitle(financeMonthOf(to))})`,
      detail:
        (state.timesheetRequired
          ? `Timesheet (${fileNames.timesheet}, ${state.timesheet?.lineCount ?? 0} line(s)) and attendance (${fileNames.attendance})`
          : `Attendance only (${fileNames.attendance}) — no timesheet required for the Office`) +
        ` submitted by ${userFullName(context.actor)}.` +
        (state.attendance.unrecordedWeekdays.length > 0 ? ` Confirmed with ${state.attendance.unrecordedWeekdays.length} weekday(s) without attendance: ${state.attendance.unrecordedWeekdays.join(', ')}.` : '') +
        (state.needs.confirmNoLines ? ' Confirmed: no timesheet lines for these dates.' : '') +
        (replacedText.length > 0 ? ` Replaces ${replacedText.join('; ')}, kept exactly as submitted.` : ''),
    });
    await notifyOffice(context, {
      type: 'timesheet_submitted',
      title: `${name} submitted ${state.timesheetRequired ? 'timesheet and attendance' : 'attendance'}: ${formatPeriod(from, to)}`,
      body: `${state.timesheetRequired ? `${fileNames.timesheet} and ` : ''}${fileNames.attendance}. Finance month ${monthTitle(financeMonthOf(to))}.${replacedText.length > 0 ? ' It replaces an earlier submission for these days.' : ''} Open Monthly payroll to include it in the Finance package.`,
      link: '/payroll',
    });
    return saved;
  } catch (cause) {
    // Another submission sharing these days got there first (the database's guard): say so plainly.
    const text = cause instanceof Error ? `${cause.message} ${String((cause as { cause?: unknown }).cause ?? '')}` : '';
    if (/overlaps (one already made|a monthly submission already made|a period already sent)/u.test(text)) {
      throw refuse('Another submission for these dates was being made at the same time.', 'payroll_submit_conflict', 'Nothing was submitted by this one. Reload My Monthly Forms to see what the office has.');
    }
    throw cause;
  }
};

/** One submission as the history and the office list it. */
export interface PayrollSubmissionView {
  readonly id: string;
  readonly kind: 'period' | 'monthly';
  readonly technicianId: UserId;
  readonly technicianName: string;
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly label: string;
  readonly financeMonth: string;
  readonly financeMonthLabel: string;
  readonly timesheetRequired: boolean;
  readonly timesheetIncluded: boolean;
  readonly fileNames: { readonly timesheet: string; readonly attendance: string };
  readonly submittedAt: IsoDateTime;
  readonly submittedByName: string | null;
  readonly current: boolean;
  readonly replacedAt: IsoDateTime | null;
  /** Downloadable stored documents (a period submission's); a monthly one is printed by month. */
  readonly documents: readonly { readonly kind: PayrollDocumentKind; readonly fileName: string; readonly pageCount: number }[];
}

const nameCache = (context: OperationContext) => {
  const names = new Map<string, string | null>();
  return async (id: UserId | null): Promise<string | null> => {
    if (id === null) return null;
    if (!names.has(id)) {
      const user = await context.repos.users.findById(id);
      names.set(id, user === null ? null : userFullName(user));
    }
    return names.get(id) ?? null;
  };
};

export const payrollSubmissionView = async (
  context: OperationContext,
  person: User,
  submission: PayrollSubmission,
  named = nameCache(context),
): Promise<PayrollSubmissionView> => ({
  id: submission.id,
  kind: 'period',
  technicianId: person.id,
  technicianName: submission.attendance.technicianName,
  from: submission.from,
  to: submission.to,
  label: formatPeriod(submission.from, submission.to),
  financeMonth: submission.financeMonth,
  financeMonthLabel: monthTitle(submission.financeMonth),
  timesheetRequired: submission.timesheetRequired,
  timesheetIncluded: submission.timesheetPeriodId !== null,
  fileNames: submission.fileNames,
  submittedAt: submission.submittedAt,
  submittedByName: await named(submission.submittedBy),
  current: (submission.supersededAt ?? null) === null,
  replacedAt: submission.supersededAt ?? null,
  documents: submission.documents.map((document) => ({ kind: document.kind, fileName: document.fileName, pageCount: document.pageCount })),
});

/**
 * A PERSON'S SUBMISSIONS, newest first: the payroll submissions and the
 * monthly ones made before them, current and replaced. Their own, or the
 * office's view of anybody's.
 */
export const listPayrollHistory = async (context: OperationContext, technicianId: string): Promise<readonly PayrollSubmissionView[]> => {
  assertMayReadAttendanceOf(context, technicianId);
  const person = await findPayrollPerson(context, technicianId);
  const named = nameCache(context);
  const [payroll, monthly] = await Promise.all([
    context.repos.payroll.listPayrollSubmissionsFor(person.id),
    context.repos.payroll.listSubmissionsFor(person.id),
  ]);
  const views = await Promise.all(payroll.map((submission) => payrollSubmissionView(context, person, submission, named)));
  for (const submission of monthly) {
    const bounds = monthBounds(submission.month);
    views.push({
      id: submission.id,
      kind: 'monthly',
      technicianId: person.id,
      technicianName: submission.attendance.technicianName,
      from: bounds.from,
      to: bounds.to,
      label: monthTitle(submission.month),
      financeMonth: submission.month,
      financeMonthLabel: monthTitle(submission.month),
      timesheetRequired: submission.timesheetPeriodId !== null,
      timesheetIncluded: submission.timesheetPeriodId !== null,
      fileNames: { timesheet: '', attendance: '' },
      submittedAt: submission.submittedAt,
      submittedByName: await named(submission.submittedBy),
      current: (submission.supersededAt ?? null) === null,
      replacedAt: submission.supersededAt ?? null,
      documents: [],
    });
  }
  return views.sort((a, b) => b.to.localeCompare(a.to) || Number(b.current) - Number(a.current) || b.submittedAt.localeCompare(a.submittedAt));
};

/** A submission for somebody allowed to read it; refused like a missing one otherwise. */
export const findReadablePayrollSubmission = async (context: OperationContext, submissionId: string): Promise<PayrollSubmission> => {
  const submission = await context.repos.payroll.findPayrollSubmission(submissionId);
  const allowed =
    submission !== null &&
    (submission.userId === context.actor.id || can(context.actor.role, 'attendance.viewAll') || can(context.actor.role, 'timesheets.viewAll') || can(context.actor.role, 'payroll.finance'));
  if (!allowed) throw refuse('That submission does not exist.', 'submission_not_found', 'Reload the list.');
  return submission!;
};

/**
 * A SUBMITTED DOCUMENT, EXACTLY AS IT WENT: the stored bytes, under the name
 * it was submitted with. Renaming the working PDF never reaches it.
 */
export const loadSubmittedPayrollDocument = async (
  context: OperationContext,
  submissionId: string,
  kind: PayrollDocumentKind,
): Promise<{ readonly fileName: string; readonly bytes: Uint8Array; readonly pageCount: number; readonly sha256: string }> => {
  const submission = await findReadablePayrollSubmission(context, submissionId);
  const document = submission.documents.find((candidate) => candidate.kind === kind);
  if (document === undefined) throw refuse('That submission has no such form.', 'document_not_found', 'An attendance-only submission has no timesheet.');
  const stored = await context.services.storage.getDocument(document.storageKey);
  if (stored === null) throw refuse('The stored form could not be read.', 'payroll_file_missing', 'Tell the office: the record of it is intact.');
  const sha256 = await sha256Hex(stored.bytes);
  if (sha256 !== document.sha256) throw refuse('The stored form does not match its record.', 'payroll_file_mismatch', 'Tell the office.');
  return { fileName: document.fileName, bytes: stored.bytes, pageCount: document.pageCount, sha256 };
};

/**
 * THE TWO OLD SUBMISSION POINTS, RETIRED. The Timesheets page's "Submit
 * timesheet" and the calendar month's "Submit" are refused, so My Monthly
 * Forms is the only place anything is submitted — and nothing submitted is
 * rewritten in place again. Corrections (TS-16) are unchanged.
 */
export const refuseRetiredSubmission = (what: 'timesheet' | 'month'): never => {
  throw refuse(
    what === 'timesheet' ? 'Timesheets are submitted on My Monthly Forms now.' : 'Monthly forms are submitted for your pay period now.',
    'submission_moved',
    'Open My Monthly Forms, choose the From and To of your pay period, check both forms, and submit them together.',
  );
};
