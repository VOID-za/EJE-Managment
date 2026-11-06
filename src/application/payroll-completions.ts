import {
  asUserId,
  can,
  completesTimesheet,
  formAwaits,
  userFullName,
  type IsoDate,
  type IsoDateTime,
  type PayrollDocumentKind,
  type PayrollCorrectionDraft,
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
 * WITHDRAW AND CORRECT (FORM-WITHDRAW-1, the owner, 6 November 2026): a form
 * COMPLETED and still awaiting Submit to Office may be withdrawn by its owner.
 * The completed form stays in the record exactly as it was completed — content
 * and PDF never touched — marked withdrawn, so it never counts for or goes in
 * a submission; a separate CORRECTION DRAFT opens on its dates (one per
 * withdrawn form), holding its data, worked on in the normal page, and must be
 * COMPLETED again — a new completed form, linked to the withdrawn one — before
 * it can be submitted. A submitted form is never withdrawn.
 *
 * Nothing here reopens, renames or replaces a submitted form, or changes a
 * completed one beyond recording, once, its submission or its withdrawal.
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
  /** FORM-WITHDRAW-1: withdrawn before Submit to Office (never submitted then). */
  readonly withdrawnAt: IsoDateTime | null;
  /** A completed correction: the withdrawn form it corrects. */
  readonly correctsId: string | null;
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
    withdrawnAt: form.withdrawnAt ?? null,
    correctsId: form.correctsId ?? null,
  };
};

/**
 * One withdrawal, as the Corrections section lists it: the withdrawn form (kept as completed, its PDF readable) and
 * where its correction stands — a draft being corrected, completed again and awaiting submission, or submitted.
 */
export interface CorrectionView {
  readonly draftId: string;
  readonly kind: PayrollDocumentKind;
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly periodLabel: string;
  readonly withdrawn: CompletedFormView;
  readonly withdrawnByName: string | null;
  readonly state: 'draft' | 'completed' | 'submitted';
  readonly replacement: CompletedFormView | null;
}

/** An open correction draft: the page it is corrected on works on these dates. */
export interface OpenCorrectionDraft {
  readonly id: string;
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly periodLabel: string;
  readonly withdrawnFileName: string;
  readonly withdrawnAt: IsoDateTime;
}

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
  /** FORM-WITHDRAW-1: the correction draft open for each form, if any — its page works on its dates. */
  readonly drafts: { readonly timesheet: OpenCorrectionDraft | null; readonly attendance: OpenCorrectionDraft | null };
  /** Every withdrawal and its correction, the latest first — kept apart from the read-only history. */
  readonly corrections: readonly CorrectionView[];
}

const readinessOf = (
  timesheetRequired: boolean,
  timesheet: PayrollFormCompletion | null,
  attendance: PayrollFormCompletion | null,
  correcting: { readonly timesheet: boolean; readonly attendance: boolean } = { timesheet: false, attendance: false },
): { readonly readiness: SubmitReadiness; readonly text: string } => {
  const attendanceMissing = correcting.attendance
    ? 'Attendance form not completed: it was withdrawn to correct it. Complete the correction on the Attendance page.'
    : 'Attendance form not completed. Complete it on the Attendance page.';
  const timesheetMissing = correcting.timesheet
    ? 'Timesheet form not completed: it was withdrawn to correct it. Complete the correction on the Timesheets page.'
    : 'Timesheet form not completed. Complete it on the Timesheets page.';
  if (!timesheetRequired) {
    return attendance === null
      ? { readiness: 'attendance_missing', text: attendanceMissing }
      : { readiness: 'ready', text: 'Ready to submit. You keep no timesheet, so your attendance goes on its own.' };
  }
  if (timesheet === null && attendance === null) return { readiness: 'none', text: 'Both forms must be completed — your timesheet and your attendance.' };
  if (attendance === null) return { readiness: 'attendance_missing', text: attendanceMissing };
  if (timesheet === null) return { readiness: 'timesheet_missing', text: timesheetMissing };
  if (timesheet.from !== attendance.from || timesheet.to !== attendance.to) {
    return {
      readiness: 'periods_differ',
      text: `The two forms must be for the same dates: your timesheet is for ${formatPeriod(timesheet.from, timesheet.to)}, your attendance for ${formatPeriod(attendance.from, attendance.to)}.`,
    };
  }
  return { readiness: 'ready', text: `Ready to submit — both forms for ${formatPeriod(timesheet.from, timesheet.to)}.` };
};

const addDays = (iso: string, days: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * The person's completed forms still waiting for Submit to Office: at most one of each kind — never a withdrawn one
 * (FORM-WITHDRAW-1) — and the correction draft open for each form.
 */
const awaitingOf = async (context: OperationContext, userId: UserId) => {
  const [all, drafts] = await Promise.all([context.repos.payroll.listFormCompletions(userId), context.repos.payroll.listCorrectionDrafts(userId)]);
  const waiting = all.filter(formAwaits);
  const open = drafts.filter((draft) => draft.completedId === null);
  return {
    all,
    drafts,
    timesheet: waiting.find((form) => form.kind === 'timesheet') ?? null,
    attendance: waiting.find((form) => form.kind === 'attendance') ?? null,
    draftOf: (kind: PayrollDocumentKind): PayrollCorrectionDraft | null => open.find((draft) => draft.kind === kind) ?? null,
  };
};

/** MY MONTHLY FORMS: the two forms awaiting submission, whether Submit to Office may be pressed, and why not. */
export const loadMyCompletedForms = async (context: OperationContext, technicianId: string): Promise<MyCompletedForms> => {
  const userId = asUserId(technicianId);
  assertMayReadForms(context, userId);
  const person = await findPayrollPerson(context, technicianId);
  const timesheetRequired = completesTimesheet(person.role);
  const [awaiting, current] = await Promise.all([awaitingOf(context, userId), currentSubmissions(context, person)]);
  const { readiness, text } = readinessOf(timesheetRequired, awaiting.timesheet, awaiting.attendance, {
    timesheet: awaiting.draftOf('timesheet') !== null,
    attendance: awaiting.draftOf('attendance') !== null,
  });
  const today = businessToday(new Date(context.services.clock.now()));
  const latest = [
    ...current.payroll.map((submission) => submission.to),
    ...current.periods.map((period) => period.to),
    ...current.monthly.map((submission) => monthBounds(submission.month).to),
    ...[awaiting.timesheet, awaiting.attendance].filter((form) => form !== null).map((form) => form!.to),
    ...awaiting.drafts.filter((draft) => draft.completedId === null).map((draft) => draft.to),
  ]
    .sort()
    .at(-1);
  const nextFrom = latest === undefined ? monthBounds(today.slice(0, 7)).from : addDays(latest, 1);
  const byId = new Map(awaiting.all.map((form) => [form.id, form]));
  const openView = (kind: PayrollDocumentKind): OpenCorrectionDraft | null => {
    const draft = awaiting.draftOf(kind);
    const withdrawn = draft === null ? undefined : byId.get(draft.withdrawnId);
    return draft === null || withdrawn === undefined
      ? null
      : { id: draft.id, from: draft.from, to: draft.to, periodLabel: formatPeriod(draft.from, draft.to), withdrawnFileName: withdrawn.fileName, withdrawnAt: withdrawn.withdrawnAt ?? draft.openedAt };
  };
  const corrections: CorrectionView[] = [];
  for (const draft of awaiting.drafts) {
    const withdrawn = byId.get(draft.withdrawnId);
    if (withdrawn === undefined) continue;
    const replacement = draft.completedId === null ? null : byId.get(draft.completedId) ?? null;
    const by = withdrawn.withdrawnBy == null ? null : await context.repos.users.findById(withdrawn.withdrawnBy);
    corrections.push({
      draftId: draft.id,
      kind: draft.kind,
      from: draft.from,
      to: draft.to,
      periodLabel: formatPeriod(draft.from, draft.to),
      withdrawn: await viewOf(context, withdrawn),
      withdrawnByName: by === null ? null : userFullName(by),
      state: replacement === null ? 'draft' : replacement.submissionId === null && (replacement.withdrawnAt ?? null) === null ? 'completed' : 'submitted',
      replacement: replacement === null ? null : await viewOf(context, replacement),
    });
  }
  return {
    timesheetRequired,
    timesheet: awaiting.timesheet === null ? null : await viewOf(context, awaiting.timesheet),
    attendance: awaiting.attendance === null ? null : await viewOf(context, awaiting.attendance),
    readiness,
    readinessText: text,
    next: { from: nextFrom, to: today >= nextFrom ? today : nextFrom },
    drafts: { timesheet: openView('timesheet'), attendance: openView('attendance') },
    corrections,
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
  readonly draft: PayrollCorrectionDraft | null;
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
  const [state, awaiting, current, names] = await Promise.all([
    loadPayrollForms(context, technicianId, from, to),
    awaitingOf(context, userId),
    currentSubmissions(context, person),
    namesFor(context, person, from, to),
  ]);
  const codes: { code: string; message: string; detail: string }[] = [];
  const add = (code: string, message: string, detail: string) => codes.push({ code, message, detail });

  const same = kind === 'timesheet' ? awaiting.timesheet : awaiting.attendance;
  const draft = awaiting.draftOf(kind);
  if (draft !== null && (draft.from !== from || draft.to !== to)) {
    add(
      'form_correction_period',
      `You are correcting your ${KIND_LABEL[kind]} for ${formatPeriod(draft.from, draft.to)}.`,
      `A correction keeps the dates of the form it corrects: complete it for ${formatPeriod(draft.from, draft.to)}.`,
    );
  }
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
    draft,
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
  const { person: _person, draft: _draft, codes: _codes, otherName: _otherName, ...check } = await checkCompletion(context, technicianId, kind, from, to);
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
  /*
   * Every write to this form's dates waits for this to finish, and is then refused (form-locks.ts). BOTH forms'
   * locks, always attendance first (as Submit to Office takes them): two tabs completing the timesheet and the
   * attendance at once are made one after the other, so the second sees the first and must match its dates.
   */
  await holdFormLock(context, userId, 'attendance');
  await holdFormLock(context, userId, 'timesheet');
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
    withdrawnAt: null,
    withdrawnBy: null,
    correctsId: checked.draft?.withdrawnId ?? null,
  });
  if (saved === null) {
    throw refuse(`Your ${KIND_LABEL[kind]} was just completed.`, 'form_already_completed', 'It was completed once and waits on My Monthly Forms.');
  }
  // A correction completed: its draft is closed, once — or this whole request is undone (its transaction).
  if (checked.draft !== null && !(await context.repos.payroll.completeCorrectionDraft(checked.draft.id, saved.id))) {
    throw refuse(`Your corrected ${KIND_LABEL[kind]} was just completed.`, 'form_already_completed', 'It was completed once and waits on My Monthly Forms.');
  }
  // The comment went with the timesheet; the next sheet starts without it. The working name went with the form.
  if (kind === 'timesheet' && (timesheet?.comment ?? '') !== '') {
    await context.repos.attendance.saveWorkingComment({ userId, comment: '', updatedBy: context.actor.id, updatedAt: now });
  }
  await context.repos.payroll.deleteDocumentName(userId, kind);
  await audit(context, {
    jobId: null,
    type: 'payroll_form_completed',
    summary: `${kind === 'timesheet' ? 'Timesheet' : 'Attendance'} ${checked.draft === null ? 'completed' : 'correction completed'}: ${userFullName(person)}, ${formatPeriod(from, to)}`,
    detail:
      `“${fileName}” — ${summaryOf(saved)}. Completed by ${userFullName(context.actor)}; locked, awaiting submission to the office.` +
      (checked.draft === null ? '' : ` It corrects the withdrawn form ${checked.draft.withdrawnId}, kept exactly as it was completed.`),
  });
  return viewOf(context, saved);
};

/**
 * WITHDRAW AND CORRECT (FORM-WITHDRAW-1). The owner withdraws a completed form still awaiting Submit to Office.
 *
 * In the request's one transaction, under both form locks (attendance first, as Complete and Submit take them, so
 * a withdrawal and a submission racing are made one after the other): checked to be the owner's, completed,
 * awaiting — never submitted, never already withdrawn — and still exactly what was completed; then marked
 * withdrawn (the database's guard allows only that, once, and never on a submitted form), its correction draft
 * opened on its dates (one per withdrawn form — a second withdrawal, retried or raced, finds it withdrawn and is
 * refused), its data given back to the draft (the comment and the name it was completed with), and audited. Its
 * content and PDF are never touched. If any step fails, nothing is withdrawn.
 */
export const withdrawCompletedForm = async (context: OperationContext, technicianId: string, completionId: string): Promise<CompletedFormView> => {
  const userId = asUserId(technicianId);
  assertOwnForm(context, userId);
  await holdFormLock(context, userId, 'attendance');
  await holdFormLock(context, userId, 'timesheet');
  const form = await context.repos.payroll.findFormCompletion(completionId);
  // Somebody else's is refused exactly like one that does not exist.
  if (form === null || form.userId !== userId) throw refuse('That completed form does not exist.', 'form_not_found', 'Reload My Monthly Forms.');
  if (form.submissionId !== null) {
    throw refuse(
      'This form was submitted to the office, so it cannot be withdrawn.',
      'form_already_submitted',
      'A submitted form is read only for good. A submitted timesheet is changed by asking for a correction on My Monthly Forms.',
    );
  }
  if ((form.withdrawnAt ?? null) !== null) {
    throw refuse('This form was already withdrawn.', 'form_already_withdrawn', 'Its correction is under Corrections on My Monthly Forms.');
  }
  const person = await findPayrollPerson(context, technicianId);
  // Still exactly as completed (its dates were locked): the draft starts from the very same data.
  if (form.kind === 'timesheet') {
    const entries = await context.repos.attendance.listEntries(person.id, form.from, form.to);
    const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    if (!sameContent(sorted, form.timesheet?.entries ?? [])) {
      throw refuse('Your timesheet changed after it was completed.', 'payroll_form_changed', 'Nothing was withdrawn. Ask the office to look into it.');
    }
  } else {
    const records = await context.repos.attendance.listRecords(form.from, form.to, person.id);
    if (!sameContent(attendancePeriodDays(form.from, form.to, records), form.attendance)) {
      throw refuse('Your attendance changed after it was completed.', 'payroll_form_changed', 'Nothing was withdrawn. Ask the office to look into it.');
    }
  }
  const now = context.services.clock.now();
  const withdrawn = await context.repos.payroll.withdrawFormCompletion(form.id, now, context.actor.id);
  if (withdrawn === null) throw refuse('This form was just withdrawn or submitted.', 'form_already_withdrawn', 'Reload My Monthly Forms.');
  const draft = await context.repos.payroll.createCorrectionDraft({
    id: context.services.ids.next('pfd'),
    userId,
    kind: form.kind,
    from: form.from,
    to: form.to,
    withdrawnId: form.id,
    completedId: null,
    openedAt: now,
    openedBy: context.actor.id,
  });
  if (draft === null) {
    // Undone with the request's transaction: never withdrawn without its draft.
    throw refuse(`A correction of your ${KIND_LABEL[form.kind]} is already open.`, 'correction_draft_open', 'Complete it before withdrawing again.');
  }
  // The draft holds the form's data: its lines or days are in their pages already (locked until now); the comment
  // and the name it was completed with come back, so completing again proposes the same.
  if (form.kind === 'timesheet' && (form.timesheet?.comment ?? '') !== '') {
    await context.repos.attendance.saveWorkingComment({ userId, comment: form.timesheet!.comment, updatedBy: context.actor.id, updatedAt: now });
  }
  await context.repos.payroll.saveDocumentName({ userId, kind: form.kind, fileName: form.fileName, updatedBy: context.actor.id, updatedAt: now });
  await audit(context, {
    jobId: null,
    type: 'payroll_form_withdrawn',
    summary: `${form.kind === 'timesheet' ? 'Timesheet' : 'Attendance'} withdrawn to correct: ${userFullName(person)}, ${formatPeriod(form.from, form.to)}`,
    detail: `“${form.fileName}” (completed ${form.completedAt.slice(0, 16).replace('T', ' ')}) withdrawn before submission by ${userFullName(context.actor)}. Kept exactly as it was completed, PDF included; correction draft ${draft.id} opened for the same dates.`,
  });
  return viewOf(context, withdrawn);
};

/**
 * The same content, whatever order its keys come in. PostgreSQL's jsonb does not keep key order (it stores them
 * shortest first), so a form read back from `payroll_form_completions` never has the order of the same data read
 * live from its tables; it is compared by value, keys sorted at every level.
 */
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]))
      : value;
export const sameContent = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

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
  const { readiness, text } = readinessOf(timesheetRequired, awaiting.timesheet, awaiting.attendance, {
    timesheet: awaiting.draftOf('timesheet') !== null,
    attendance: awaiting.draftOf('attendance') !== null,
  });
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
  if (!sameContent(attendancePeriodDays(from, to, records), attendanceForm.attendance)) {
    throw refuse('Your attendance changed after it was completed.', 'payroll_form_changed', 'Nothing was submitted. Ask the office to look into it.');
  }
  if (timesheetForm !== null) {
    const entries = await context.repos.attendance.listEntries(person.id, from, to);
    const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    if (!sameContent(sorted, timesheetForm.timesheet?.entries ?? [])) {
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
