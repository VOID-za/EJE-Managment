import { monthBounds } from '@/lib/payroll-files';
import { formatPeriod } from '@/lib/timesheet-dates';
import { formAwaits, type IsoDate, type PayrollDocumentKind, type UserId } from '@/domain';
import type { OperationContext } from './context';
import { WorkflowError } from './errors';

/**
 * DATES A FORM HAS LOCKED. FORM-LIFECYCLE-1 (the owner, 6 November 2026).
 *
 * Once a person COMPLETES their timesheet or attendance for From–To, those
 * dates are final for that form: nothing in them is added, changed, cleared or
 * removed — by the page, another tab or device, or a request made by hand.
 * Submitted ATTENDANCE keeps its dates locked (a day has one attendance).
 *
 * A SUBMITTED TIMESHEET DOES NOT LOCK ITS DATES (REPEAT-DATES-1, the owner,
 * 7 November 2026): the same calendar date may be in any number of submitted
 * timesheets. What is paid once is the LINE: a submitted line is never changed,
 * moved or removed (refused by the line, `submissionHolding`), and never in a
 * second submission (`openEntries`, and the database's line ledger). Every write
 * path of both forms asks here, on the server.
 *
 * Kept small and free of the other payroll modules, so the timesheet and
 * attendance operations can call it without an import cycle.
 */
export interface LockedRange {
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly why: 'completed' | 'submitted';
}

const refuse = (message: string, code: string, detail: string): WorkflowError =>
  new WorkflowError(message, [{ code, message: detail }]);

/**
 * Every range the person's `kind` form is locked for: the completed form awaiting submission, and — attendance
 * only — what was submitted. Only the PERSON's own forms, current ones: a replaced submission, somebody else's, a
 * withdrawn form (FORM-WITHDRAW-1), a correction draft, a submitted TIMESHEET (REPEAT-DATES-1) or a date merely in
 * the past never locks anything.
 */
export const lockedRanges = async (context: OperationContext, userId: UserId, kind: PayrollDocumentKind): Promise<readonly LockedRange[]> => {
  const [completions, payroll, monthly] = await Promise.all([
    context.repos.payroll.listFormCompletions(userId),
    kind === 'attendance' ? context.repos.payroll.listPayrollSubmissionsFor(userId) : Promise.resolve([]),
    kind === 'attendance' ? context.repos.payroll.listSubmissionsFor(userId) : Promise.resolve([]),
  ]);
  // REPEAT-DATES-1: a submitted timesheet locks no date — its lines are held by their identity instead.
  return [
    ...completions.filter((form) => form.kind === kind && formAwaits(form)).map((form) => ({ from: form.from, to: form.to, why: 'completed' as const })),
    ...payroll.filter((submission) => (submission.supersededAt ?? null) === null).map((submission) => ({ from: submission.from, to: submission.to, why: 'submitted' as const })),
    ...monthly.filter((submission) => (submission.supersededAt ?? null) === null).map((submission) => ({ ...monthBounds(submission.month), why: 'submitted' as const })),
  ];
};

/**
 * THE PERSON'S FORM LOCK. Every write to a timesheet or attendance date, and
 * every completion of that form, takes it first. In PostgreSQL it is an
 * advisory lock held until the request's transaction ends, so a completion
 * and a save racing it are made one after the other: the save either lands
 * before the completion reads the form (and is in it), or waits and is then
 * refused — never written into a form already completed. (The in-memory
 * demonstration takes it and lets go at once; it has no transactions.)
 */
export const holdFormLock = async (context: OperationContext, userId: UserId, kind: PayrollDocumentKind): Promise<void> => {
  const release = await context.repos.attendance.lockLine(`form:${kind}:${userId}`);
  release();
};

/**
 * Refuses when any of these dates is locked for the person's `kind` form.
 * `form_completed` while the form awaits submission; `form_submitted` once
 * attendance went to the office. Null dates (a draft with none yet) are open.
 *
 * `leaving` (v1.7.1): the dates a WORKING line is taken away from — removed,
 * or moved to another date. A submitted form does not hold them; a completed
 * form still does — its lines are in it.
 */
export const assertDatesOpen = async (
  context: OperationContext,
  userId: UserId,
  kind: PayrollDocumentKind,
  dates: readonly (string | null | undefined)[],
  options: { readonly leaving?: boolean } = {},
): Promise<void> => {
  const wanted = dates.filter((date): date is string => typeof date === 'string' && date !== '');
  if (wanted.length === 0) return;
  await holdFormLock(context, userId, kind);
  const ranges = await lockedRanges(context, userId, kind);
  for (const date of wanted) {
    const locked = ranges.find((range) => range.from <= date && date <= range.to && !(options.leaving === true && range.why === 'submitted'));
    if (locked === undefined) continue;
    const form = kind === 'timesheet' ? 'timesheet' : 'attendance';
    throw locked.why === 'completed'
      ? refuse(
          `Your ${form} for ${formatPeriod(locked.from, locked.to)} is completed, so ${date} cannot be changed.`,
          'form_completed',
          `A completed form is locked. It waits on My Monthly Forms to be submitted to the office; nothing in its dates can be changed.`,
        )
      : refuse(
          `Your ${form} for ${formatPeriod(locked.from, locked.to)} was submitted to the office, so ${date} cannot be changed.`,
          'form_submitted',
          kind === 'timesheet'
            ? 'A submitted timesheet is read-only. To change it, ask for a correction under Corrections on My Monthly Forms.'
            : 'Submitted attendance is read-only.',
        );
  }
};
