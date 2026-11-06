import {
  asUserId,
  can,
  completesTimesheet,
  userFullName,
  type IsoDate,
  type IsoDateTime,
  type PayrollDocumentKind,
  type PayrollFormCompletion,
  type PayrollSubmission,
  type User,
  type UserId,
} from '@/domain';
import { businessToday } from '@/lib/business-time';
import { sha256Hex } from '@/lib/job-card/document-identity';
import { monthBounds } from '@/lib/payroll-files';
import { normalisePdfFileName, sameFileName } from '@/lib/pdf-file-name';
import { formatDayAndDate, formatPeriod } from '@/lib/timesheet-dates';
import { renderAttendancePdf } from '@/services/simulated/attendance-pdf';
import { renderTimesheetPdf } from '@/services/simulated/timesheet-pdf';
import type { OperationContext } from './context';
import { audit } from './audit';
import { WorkflowError } from './errors';
import { findPayrollPerson } from './attendance-document';
import { holdFormLock } from './form-locks';
import {
  assertPayrollPeriod,
  attendancePeriodDays,
  currentSubmissions,
  loadPayrollForms,
  namesFor,
  oneFormPage,
  relation,
  submitPayrollForms,
  workingAttendanceDocument,
} from './payroll-forms';
import { loadTimesheetDocument } from './timesheets';

/**
 * EACH FORM COMPLETED ON ITS OWN; BOTH SUBMITTED TO THE OFFICE TOGETHER.
 * FORM-LIFECYCLE-1 (the owner, 6 November 2026). docs/payroll-forms.md.
 *
 *   1. IN PROGRESS — the Timesheets and Attendance pages: every change saves itself.
 *   2. COMPLETED — Completed → the form is named → OK. Checked here, on the
 *      server; then its content and its PDF are frozen (`payroll_form_completions`,
 *      write-once), its dates are locked against every change (`form-locks.ts`),
 *      and it moves to My Monthly Forms, awaiting submission. Either form may be
 *      completed first; one never completes the other.
 *   3. SUBMITTED — Submit to Office on My Monthly Forms sends BOTH completed
 *      forms (attendance alone for a role that keeps no timesheet), for the
 *      same From–To, as ONE payroll submission, in the request's one
 *      transaction. Never one form on its own. Permanently read-only.
 *   4. HISTORY — every submission, read only, with its documents as they went.
 *
 * Nothing here reopens, renames or replaces a completed or submitted form.
 */

const refuse = (message: string, code: string, detail: string): WorkflowError =>
  new WorkflowError(message, [{ code, message: detail }]);

const KIND_LABEL: Record<PayrollDocumentKind, string> = { timesheet: 'timesheet', attendance: 'attendance form' };

const assertOwnForm = (context: OperationContext, userId: UserId): void => {
  if (context.actor.id === userId) return;
  throw refuse(
    'You can only complete and submit your own forms.',
    'not_permitted',
    'Each person completes and submits their own timesheet and attendance; nobody does it for another person.',
  );
};

/** The person may read these completed forms: their own, or the office's right to read everybody's payroll. */
const assertMayReadForms = (context: OperationContext, userId: UserId): void => {
  if (context.actor.id === userId || can(context.actor.role, 'timesheets.viewAll')) return;
  throw refuse('Those forms are not yours.', 'not_permitted', 'Each person reads their own forms; the office reads everybody’s.');
};

const assertKind = (kind: string): PayrollDocumentKind => {
  if (kind === 'timesheet' || kind === 'attendance') return kind;
  throw refuse('That is not one of the forms.', 'invalid_kind', 'Timesheet or attendance.');
};

/** One completed form, as My Monthly Forms lists it. */
export interface CompletedFormView {
  readonly id: string;
  readonly kind: PayrollDocumentKind;
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly periodLabel: string;
  readonly fileName: string;
  readonly completedAt: IsoDateTime;
  readonly completedByName: string | null;
  readonly pageCount: number;
  /** "4 lines" / "18 present, 1 absent, 2 not recorded". */
  readonly summary: string;
  readonly submissionId: string | null;
}

const summaryOf = (form: PayrollFormCompletion): string => {
  if (form.kind === 'timesheet') {
    const lines = form.timesheet?.entries.length ?? 0;
    return `${lines} line${lines === 1 ? '' : 's'}`;
  }
  const days = form.attendance ?? [];
  const present = days.filter((day) => day.status === 'present').length;
  const absent = days.filter((day) => day.status === 'absent').length;
  const unrecorded = days.filter((day) => day.status === null).length;
  return `${present} present, ${absent} absent, ${unrecorded} not recorded`;
};

const viewOf = async (context: OperationContext, form: PayrollFormCompletion): Promise<CompletedFormView> => {
  const by = await context.repos.users.findById(form.completedBy);
  return {
    id: form.id,
    kind: form.kind,
    from: form.from,
    to: form.to,
    periodLabel: formatPeriod(form.from, form.to),
    fileName: form.fileName,
    completedAt: form.completedAt,
    completedByName: by === null ? null : userFullName(by),
    pageCount: form.document.pageCount,
    summary: summaryOf(form),
    submissionId: form.submissionId,
  };
};

/** Why Submit to Office is (not) offered — said in words under the button, never only a tooltip. */
export type SubmitReadiness = 'ready' | 'none' | 'timesheet_missing' | 'attendance_missing' | 'periods_differ';

export interface MyCompletedForms {
  readonly timesheetRequired: boolean;
  readonly timesheet: CompletedFormView | null;
  readonly attendance: CompletedFormView | null;
  readonly readiness: SubmitReadiness;
  readonly readinessText: string;
  /** The dates a new form starts from: the day after everything completed or submitted, to today. */
  readonly next: { readonly from: IsoDate; readonly to: IsoDate };
}

const readinessOf = (
  timesheetRequired: boolean,
  timesheet: PayrollFormCompletion | null,
  attendance: PayrollFormCompletion | null,
): { readonly readiness: SubmitReadiness; readonly text: string } => {
  if (!timesheetRequired) {
    return attendance === null
      ? { readiness: 'attendance_missing', text: 'Attendance form not completed. Complete it on the Attendance page.' }
      : { readiness: 'ready', text: 'Ready to submit. You keep no timesheet, so your attendance goes on its own.' };
  }
  if (timesheet === null && attendance === null) return { readiness: 'none', text: 'Both forms must be completed — your timesheet and your attendance.' };
  if (attendance === null) return { readiness: 'attendance_missing', text: 'Attendance form not completed. Complete it on the Attendance page.' };
  if (timesheet === null) return { readiness: 'timesheet_missing', text: 'Timesheet form not completed. Complete it on the Timesheets page.' };
  if (timesheet.from !== attendance.from || timesheet.to !== attendance.to) {
    return {
      readiness: 'periods_differ',
      text: `The two forms must be for the same dates: your timesheet is for ${formatPeriod(timesheet.from, timesheet.to)}, your attendance for ${formatPeriod(attendance.from, attendance.to)}.`,
    };
  }
  return { readiness: 'ready', text: `Ready to submit — both forms for ${formatPeriod(timesheet.from, timesheet.to)}.` };
};

const addDays = (iso: string, days: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** The person's completed forms still waiting for Submit to Office: at most one of each kind. */
const awaitingOf = async (context: OperationContext, userId: UserId) => {
  const all = await context.repos.payroll.listFormCompletions(userId);
  const waiting = all.filter((form) => form.submissionId === null);
  return {
    all,
    timesheet: waiting.find((form) => form.kind === 'timesheet') ?? null,
    attendance: waiting.find((form) => form.kind === 'attendance') ?? null,
  };
};

/** MY MONTHLY FORMS: the two forms awaiting submission, whether Submit to Office may be pressed, and why not. */
export const loadMyCompletedForms = async (context: OperationContext, technicianId: string): Promise<MyCompletedForms> => {
  const userId = asUserId(technicianId);
  assertMayReadForms(context, userId);
  const person = await findPayrollPerson(context, technicianId);
  const timesheetRequired = completesTimesheet(person.role);
  const [awaiting, current] = await Promise.all([awaitingOf(context, userId), currentSubmissions(context, person)]);
  const { readiness, text } = readinessOf(timesheetRequired, awaiting.timesheet, awaiting.attendance);
  const today = businessToday(new Date(context.services.clock.now()));
  const latest = [
    ...current.payroll.map((submission) => submission.to),
    ...current.periods.map((period) => period.to),
    ...current.monthly.map((submission) => monthBounds(submission.month).to),
    ...[awaiting.timesheet, awaiting.attendance].filter((form) => form !== null).map((form) => form!.to),
  ]
    .sort()
    .at(-1);
  const nextFrom = latest === undefined ? monthBounds(today.slice(0, 7)).from : addDays(latest, 1);
  return {
    timesheetRequired,
    timesheet: awaiting.timesheet === null ? null : await viewOf(context, awaiting.timesheet),
    attendance: awaiting.attendance === null ? null : await viewOf(context, awaiting.attendance),
    readiness,
    readinessText: text,
    next: { from: nextFrom, to: today >= nextFrom ? today : nextFrom },
  };
};

/** What the Completed dialog shows before OK: the name it proposes, what stops it, and what must be confirmed. */
export interface CompletionCheck {
  readonly kind: PayrollDocumentKind;
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly periodLabel: string;
  /** The working name the person gave it, or the default for these dates. */
  readonly fileName: string;
  /** Plain sentences: what stops completing it now. Empty when it can be completed. */
  readonly problems: readonly string[];
  readonly needs: { readonly confirmUnrecorded: boolean; readonly confirmNoLines: boolean };
  readonly unrecordedWeekdays: readonly IsoDate[];
  readonly lineCount: number;
  /** The other form is completed for these dates: this one must have the same. */
  readonly mustMatch: { readonly from: IsoDate; readonly to: IsoDate } | null;
}

interface Checked extends CompletionCheck {
  readonly person: User;
  readonly codes: readonly { readonly code: string; readonly message: string; readonly detail: string }[];
  readonly otherName: string | null;
}

const checkCompletion = async (context: OperationContext, technicianId: string, kindText: string, from: string, to: string): Promise<Checked> => {
  const userId = asUserId(technicianId);
  assertOwnForm(context, userId);
  const kind = assertKind(kindText);
  assertPayrollPeriod(from, to);
  const person = await findPayrollPerson(context, technicianId);
  const timesheetRequired = completesTimesheet(person.role);
  if (kind === 'timesheet' && !timesheetRequired) {
    throw refuse('You keep no timesheet.', 'timesheet_not_required', 'The Office completes and submits attendance only.');
  }
  const today = businessToday(new Date(context.services.clock.now()));
  const [state, awaiting, current, names] = await Promise.all([
    loadPayrollForms(context, technicianId, from, to),
    awaitingOf(context, userId),
    currentSubmissions(context, person),
    namesFor(context, person, from, to),
  ]);
  const codes: { code: string; message: string; detail: string }[] = [];
  const add = (code: string, message: string, detail: string) => codes.push({ code, message, detail });

  const same = kind === 'timesheet' ? awaiting.timesheet : awaiting.attendance;
  const other = kind === 'timesheet' ? awaiting.attendance : awaiting.timesheet;
  if (same !== null) {
    add('form_already_completed', `Your ${KIND_LABEL[kind]} for ${formatPeriod(same.from, same.to)} is already completed.`, 'It waits on My Monthly Forms. Submit it to the office there before completing the next one.');
  }
  if (other !== null && (other.from !== from || other.to !== to)) {
    add(
      'form_period_mismatch',
      `Your ${KIND_LABEL[other.kind]} is completed for ${formatPeriod(other.from, other.to)}.`,
      `Both forms are submitted together, for the same dates: complete this one for ${formatPeriod(other.from, other.to)} too.`,
    );
  }
  const submitted = [
    ...current.payroll.map((submission) => ({ from: submission.from, to: submission.to })),
    ...current.monthly.map((submission) => monthBounds(submission.month)),
    ...current.periods.map((period) => ({ from: period.from, to: period.to })),
  ].filter((range) => relation(from, to, range) !== 'apart');
  if (submitted.length > 0) {
    add(
      'payroll_period_submitted',
      `These dates include forms already submitted to the office (${submitted.map((range) => formatPeriod(range.from, range.to)).join('; ')}).`,
      'A submitted form is never submitted again. Choose dates that start after it ends.',
    );
  }
  // Only lines IN these dates: a draft with no date belongs to no form yet.
  const incomplete = (state.timesheet?.incomplete ?? []).filter((line) => line.date !== null);
  if (kind === 'timesheet' && incomplete.length > 0) {
    add(
      'timesheet_lines_incomplete',
      `${incomplete.length} timesheet line${incomplete.length === 1 ? ' is' : 's are'} not complete.`,
      `${incomplete.map((line) => `${formatDayAndDate(line.date!)}: ${line.problems.join(' ')}`).join(' · ')} Complete or remove ${incomplete.length === 1 ? 'it' : 'them'} first.`,
    );
  }
  if (kind === 'attendance' && state.attendance.absentWithoutReason.length > 0) {
    add('absence_reason_required', 'An absent day has no reason.', `Give the reason for ${state.attendance.absentWithoutReason.map(formatDayAndDate).join(', ')} first.`);
  }
  const otherName = other?.fileName ?? null;
  return {
    person,
    codes,
    otherName,
    kind,
    from,
    to,
    periodLabel: formatPeriod(from, to),
    fileName: names.names[kind],
    problems: codes.map((entry) => `${entry.message} ${entry.detail}`),
    needs: {
      confirmUnrecorded: kind === 'attendance' && state.attendance.unrecordedWeekdays.length > 0,
      confirmNoLines: kind === 'timesheet' && (state.timesheet?.lineCount ?? 0) === 0,
    },
    unrecordedWeekdays: kind === 'attendance' ? state.attendance.unrecordedWeekdays : [],
    lineCount: state.timesheet?.lineCount ?? 0,
    mustMatch: other === null ? null : { from: other.from, to: other.to },
  };
};

/** The Completed dialog's question to the server: may this form be completed for these dates, and under what name. Read only. */
export const checkFormCompletion = async (context: OperationContext, technicianId: string, kind: string, from: string, to: string): Promise<CompletionCheck> => {
  const { person: _person, codes: _codes, otherName: _otherName, ...check } = await checkCompletion(context, technicianId, kind, from, to);
  return check;
};

export interface CompleteFormInput {
  readonly kind: string;
  readonly from: string;
  readonly to: string;
  /** The name typed in the dialog; empty keeps the proposed one. */
  readonly fileName: string;
  readonly confirmUnrecorded?: boolean | undefined;
  readonly confirmNoLines?: boolean | undefined;
}

/**
 * COMPLETE ONE FORM (OK in the Completed dialog). Checked here, then frozen and
 * locked in the request's one transaction: the content and the PDF as they are
 * now, under the chosen name. A repeated OK (the same request again) is
 * answered from the idempotency store; a second completion — another tab, a
 * race — is refused by the database's unique key, so there is never a second
 * form. Nothing is written when anything is refused.
 */
export const completePayrollForm = async (context: OperationContext, technicianId: string, input: CompleteFormInput): Promise<CompletedFormView> => {
  const userId = asUserId(technicianId);
  assertOwnForm(context, userId);
  const kind = assertKind(input.kind);
  // Every write to this form's dates waits for this to finish, and is then refused (form-locks.ts).
  await holdFormLock(context, userId, kind);
  const checked = await checkCompletion(context, technicianId, kind, input.from, input.to);
  const first = checked.codes[0];
  if (first !== undefined) throw refuse(first.message, first.code, first.detail);
  if (checked.needs.confirmUnrecorded && input.confirmUnrecorded !== true) {
    throw refuse(
      `${checked.unrecordedWeekdays.length} weekday${checked.unrecordedWeekdays.length === 1 ? ' has' : 's have'} no attendance recorded.`,
      'attendance_incomplete',
      `${checked.unrecordedWeekdays.map(formatDayAndDate).join(', ')}. Record them, or confirm they are right as they are (Not recorded).`,
    );
  }
  if (checked.needs.confirmNoLines && input.confirmNoLines !== true) {
    throw refuse('Your timesheet has no lines for these dates.', 'timesheet_empty_unconfirmed', 'Add your lines, or confirm you have nothing to claim for these dates.');
  }
  let fileName = checked.fileName;
  if (input.fileName.trim() !== '') {
    const named = normalisePdfFileName(input.fileName);
    if (!named.ok) throw refuse('That form name cannot be used.', 'invalid_file_name', named.problem);
    fileName = named.name;
  }
  if (checked.otherName !== null && sameFileName(checked.otherName, fileName)) {
    throw refuse(
      'Both forms would have the same name.',
      'duplicate_file_name',
      `Your completed ${kind === 'timesheet' ? 'attendance form' : 'timesheet'} is already called “${checked.otherName}”. Give this one its own name.`,
    );
  }

  const { person, from, to } = checked;
  const now = context.services.clock.now();
  const id = context.services.ids.next('pfc');
  // The content and the document, frozen together from the same reading.
  let timesheet: PayrollFormCompletion['timesheet'] = null;
  let attendance: PayrollFormCompletion['attendance'] = null;
  let rendered: { readonly bytes: Uint8Array; readonly pageCount: number };
  if (kind === 'timesheet') {
    const [entries, working, document] = await Promise.all([
      context.repos.attendance.listEntries(person.id, from, to),
      context.repos.attendance.findWorkingComment(person.id),
      loadTimesheetDocument(context, person.id, from, to, 'working'),
    ]);
    timesheet = { comment: working?.comment ?? '', entries: [...entries].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)) };
    rendered = renderTimesheetPdf({ ...document, fileName, versionLabel: 'Completed — awaiting submission to the office' }, { generatedAt: now });
  } else {
    const records = await context.repos.attendance.listRecords(from, to, person.id);
    attendance = attendancePeriodDays(from, to, records);
    const document = await workingAttendanceDocument(context, person, from, to, fileName);
    rendered = oneFormPage('attendance form', () => renderAttendancePdf({ ...document, versionLabel: 'Completed — awaiting submission to the office' }, { generatedAt: now }));
  }
  const storageKey = `payroll-completions/${id}/${kind}.pdf`;
  await context.services.storage.putDocument({ storageKey, fileName, contentType: 'application/pdf', bytes: rendered.bytes, renderer: 1, backfilled: false });
  const back = await context.services.storage.getDocument(storageKey);
  if (back === null || back.bytes.byteLength !== rendered.bytes.byteLength) {
    throw refuse('The form could not be stored.', 'payroll_file_not_stored', 'Nothing was completed. Try again.');
  }
  const saved = await context.repos.payroll.createFormCompletion({
    id,
    userId,
    kind,
    from,
    to,
    fileName,
    timesheet,
    attendance,
    document: { kind, fileName, storageKey, sha256: await sha256Hex(rendered.bytes), sizeBytes: rendered.bytes.byteLength, pageCount: rendered.pageCount },
    completedAt: now,
    completedBy: context.actor.id,
    submissionId: null,
  });
  if (saved === null) {
    throw refuse(`Your ${KIND_LABEL[kind]} was just completed.`, 'form_already_completed', 'It was completed once and waits on My Monthly Forms.');
  }
  // The comment went with the timesheet; the next sheet starts without it. The working name went with the form.
  if (kind === 'timesheet' && (timesheet?.comment ?? '') !== '') {
    await context.repos.attendance.saveWorkingComment({ userId, comment: '', updatedBy: context.actor.id, updatedAt: now });
  }
  await context.repos.payroll.deleteDocumentName(userId, kind);
  await audit(context, {
    jobId: null,
    type: 'payroll_form_completed',
    summary: `${kind === 'timesheet' ? 'Timesheet' : 'Attendance'} completed: ${userFullName(person)}, ${formatPeriod(from, to)}`,
    detail: `“${fileName}” — ${summaryOf(saved)}. Completed by ${userFullName(context.actor)}; locked, awaiting submission to the office.`,
  });
  return viewOf(context, saved);
};

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * SUBMIT TO OFFICE: both completed forms together, as one payroll submission.
 *
 * Checked on the server, whatever the button showed: the person's own forms,
 * both completed (attendance alone for a role that keeps no timesheet), for
 * the same dates, still awaiting, and still EXACTLY as completed (their dates
 * have been locked since). Then, in the request's one transaction, the
 * existing submission is made from them — under their completed names, with
 * the timesheet's frozen comment — and both are marked as part of it. If any
 * step fails, nothing is submitted and both forms still await. A repeated
 * request is answered from the idempotency store; a racing one finds the forms
 * already submitted and is refused.
 */
export const submitCompletedForms = async (context: OperationContext, technicianId: string): Promise<PayrollSubmission> => {
  const userId = asUserId(technicianId);
  assertOwnForm(context, userId);
  const person = await findPayrollPerson(context, technicianId);
  const timesheetRequired = completesTimesheet(person.role);
  await holdFormLock(context, userId, 'attendance');
  if (timesheetRequired) await holdFormLock(context, userId, 'timesheet');
  const awaiting = await awaitingOf(context, userId);
  const { readiness, text } = readinessOf(timesheetRequired, awaiting.timesheet, awaiting.attendance);
  if (readiness !== 'ready') {
    const recent = awaiting.all.find((form) => form.submissionId !== null);
    throw readiness === 'none' && recent !== undefined && awaiting.timesheet === null && awaiting.attendance === null
      ? refuse('These forms were already submitted to the office.', 'payroll_already_submitted', 'They are in your history. Nothing was submitted again.')
      : refuse('Both forms must be completed before they are submitted.', `submit_${readiness}`, text);
  }
  const attendanceForm = awaiting.attendance!;
  const timesheetForm = timesheetRequired ? awaiting.timesheet! : null;
  const { from, to } = attendanceForm;

  // Still exactly as completed — the lock makes anything else a fault; it is refused, never submitted.
  const records = await context.repos.attendance.listRecords(from, to, person.id);
  if (!sameJson(attendancePeriodDays(from, to, records), attendanceForm.attendance)) {
    throw refuse('Your attendance changed after it was completed.', 'payroll_form_changed', 'Nothing was submitted. Ask the office to look into it.');
  }
  if (timesheetForm !== null) {
    const entries = await context.repos.attendance.listEntries(person.id, from, to);
    const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    if (!sameJson(sorted, timesheetForm.timesheet?.entries ?? [])) {
      throw refuse('Your timesheet changed after it was completed.', 'payroll_form_changed', 'Nothing was submitted. Ask the office to look into it.');
    }
  }

  const state = await loadPayrollForms(context, technicianId, from, to);
  const submission = await submitPayrollForms(
    context,
    technicianId,
    { from, to, revision: state.revision, confirmUnrecorded: true, confirmNoLines: true, confirmReplace: false },
    {
      fileNames: { timesheet: timesheetForm?.fileName ?? '', attendance: attendanceForm.fileName },
      timesheetComment: timesheetForm?.timesheet?.comment ?? '',
    },
  );
  const ids = [attendanceForm.id, ...(timesheetForm === null ? [] : [timesheetForm.id])];
  const marked = await context.repos.payroll.markFormsSubmitted(ids, submission.id);
  if (marked !== ids.length) {
    // Another request submitted them in between: this whole request is undone (its transaction), never half-made.
    throw refuse('These forms were just submitted.', 'payroll_already_submitted', 'They were submitted once; the office has them.');
  }
  return submission;
};

/** A completed form's PDF, exactly as it was stored when it was completed. The owner's, or the office's to read. */
export const loadCompletedFormPdf = async (
  context: OperationContext,
  completionId: string,
): Promise<{ readonly fileName: string; readonly bytes: Uint8Array }> => {
  const form = await context.repos.payroll.findFormCompletion(completionId);
  if (form === null) throw refuse('That completed form does not exist.', 'form_not_found', 'Reload My Monthly Forms.');
  // Somebody else's is refused exactly like one that does not exist.
  if (form.userId !== context.actor.id && !can(context.actor.role, 'timesheets.viewAll')) {
    throw refuse('That completed form does not exist.', 'form_not_found', 'Reload My Monthly Forms.');
  }
  const stored = await context.services.storage.getDocument(form.document.storageKey);
  if (stored === null) throw refuse('The completed form’s file is missing.', 'payroll_file_missing', 'Ask the office to restore it from the backup.');
  return { fileName: form.fileName, bytes: stored.bytes };
};
