import {
  TIMESHEET_MAX_HOURS_PER_DAY,
  asUserId,
  userFullName,
  type IsoDate,
  type IsoDateTime,
  type TimesheetEntry,
  type TimesheetLineDraft,
  type TimesheetLineTyped,
  type TimesheetPeriod,
  type UserId,
} from '@/domain';
import {
  WORKSHOP_PICK,
  parseTyped,
  randToCents,
  sameTypedLine,
  timesheetLineProblems,
  typedOfEntry,
  type TimesheetLineProblem,
} from '@/lib/timesheet-line';
import { formatDayAndDate, formatPeriod } from '@/lib/timesheet-dates';
import type { OperationContext } from './context';
import { audit } from './audit';
import { WorkflowError } from './errors';
import { assertDatesOpen, lockedRanges } from './form-locks';
import { assertMayRead, assertOwner, saveTimesheetEntry, removeTimesheetEntry, submittedLineHolders } from './timesheets';

/**
 * TIMESHEET LINES THAT SAVE THEMSELVES. PAYROLL-ONE-1 (the owner, 5 November
 * 2026): "All changes must save automatically … Incomplete lines must remain
 * saved as drafts. Do not silently discard them."
 *
 * Every change the technician makes to a line is sent as the line AS TYPED.
 * The server decides what it is:
 *
 *  - COMPLETE (a date, numbers it can store, something said — see
 *    `timesheetLineProblems`, plus a customer in the register and a day of at
 *    most 24 hours): written as the timesheet entry, through exactly the
 *    rules and audit trail every line has always had (`saveTimesheetEntry`);
 *    a draft it had is removed.
 *  - NOT COMPLETE: kept as a DRAFT under the same id, exactly as typed, with
 *    what it still needs. A stored line being changed keeps its last complete
 *    values until the draft is complete. Nothing is lost, nothing invented.
 *
 * THE LINE'S ID IS THE SCREEN'S, given when the line is added, so a retried
 * save never makes a second line. Each save says which REVISION of the line
 * the screen was showing; a save made from an older revision — another tab,
 * another device — is refused (`timesheet_line_changed`) instead of
 * overwriting the newer line. Repeating what the line already says is never a
 * conflict, so a retry after a lost answer succeeds.
 *
 * A LINE IN A CURRENT SUBMISSION is part of what was submitted: it is shown,
 * and it is changed only by a correction (TS-16) — never by typing over it.
 * Only the owner writes; the office reads (as before).
 */

const refuse = (message: string, code: string, detail: string): WorkflowError =>
  new WorkflowError(message, [{ code, message: detail }]);

/** A timestamp as the database writes it, read as an instant ("2026-11-05 18:30:02.725+00" or ISO). */
const instantOf = (value: string): number => Date.parse(value.includes('T') ? value : value.replace(' ', 'T').replace(/([+-]\d{2})$/u, '$1:00'));

/** `now`, or one millisecond after `previous` when the clock has not moved past it. */
export const laterThan = (now: string, previous: string | null): string => {
  if (previous === null) return now;
  const before = instantOf(previous);
  return Number.isFinite(before) && Date.parse(now) <= before ? new Date(before + 1).toISOString() : now;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** One line of the open sheet as the screen shows it. */
export interface WorkingTimesheetLine {
  readonly id: string;
  readonly date: IsoDate | null;
  /** What the line says now: the draft when there is one, else the stored line. */
  readonly typed: TimesheetLineTyped;
  /** False while it is a draft — it then blocks the submission of any period holding its date. */
  readonly complete: boolean;
  readonly problems: readonly TimesheetLineProblem[];
  /** The revision the next save must name: when the line (or its draft) was last written. */
  readonly revision: IsoDateTime;
  /** The stored, complete line — null for a line that has only ever been a draft. */
  readonly entry: TimesheetEntry | null;
  /** NT and the old call-out count a line written before 28 October 2026 carries. */
  readonly historical: { readonly normalHours: number; readonly callouts: number };
  /** Set when it is part of a current submission: shown, not editable (a correction changes it). */
  readonly submitted: { readonly periodId: string; readonly from: IsoDate; readonly to: IsoDate } | null;
  /**
   * FORM-LIFECYCLE-1: set when its date is in the person's COMPLETED timesheet awaiting submission — locked,
   * and no longer part of the working sheet (it is on My Monthly Forms). Absent on an older client's copy.
   */
  readonly completed?: { readonly from: IsoDate; readonly to: IsoDate } | null;
}

/**
 * The submitted timesheets with the lines each holds (REPEAT-DATES-1: by the line, `submittedLineHolders` — a
 * submitted line is held for good, whatever its date and whichever dates are worked on now).
 */
export const currentSubmittedLines = async (
  context: OperationContext,
  userId: UserId,
): Promise<readonly { readonly period: TimesheetPeriod; readonly entries: readonly { readonly id: string }[] }[]> =>
  (await submittedLineHolders(context, userId)).map(({ period, ids }) => ({ period, entries: [...ids].map((id) => ({ id })) }));

const lineOf = (
  entry: TimesheetEntry | null,
  draft: TimesheetLineDraft | null,
  submitted: WorkingTimesheetLine['submitted'],
  serverProblems: readonly TimesheetLineProblem[] = [],
): WorkingTimesheetLine => {
  const typed = draft?.typed ?? typedOfEntry(entry!);
  const date = draft !== null ? draft.date : entry!.date;
  const problems = [...timesheetLineProblems(date, typed), ...serverProblems];
  return {
    id: draft?.id ?? entry!.id,
    date,
    typed,
    // A stored line that is empty (all zero, no customer) is not complete either: it was never filled in.
    complete: draft === null && problems.length === 0,
    problems: draft !== null && problems.length === 0
      ? [{ field: 'line', message: 'Kept as a draft — change any field to save it as a line, or remove it.' }]
      : problems,
    revision: draft?.updatedAt ?? entry!.updatedAt,
    entry,
    historical: { normalHours: entry?.normalHours ?? 0, callouts: entry?.callouts ?? 0 },
    submitted,
  };
};

/**
 * EVERY LINE OF THE SHEET, complete and draft, any date — and those in a
 * current submission, marked so. Oldest date first; undated drafts last.
 */
export const loadWorkingLines = async (context: OperationContext, technicianId: string): Promise<readonly WorkingTimesheetLine[]> => {
  const id = asUserId(technicianId);
  assertMayRead(context, id);
  const [entries, drafts, held] = await Promise.all([
    context.repos.attendance.listEntries(id, '0001-01-01', '9999-12-31'),
    context.repos.attendance.listLineDrafts(id),
    currentSubmittedLines(context, id),
  ]);
  const submittedOf = (entryId: string): WorkingTimesheetLine['submitted'] => {
    const holding = held.find(({ entries: lines }) => lines.some((line) => line.id === entryId));
    return holding === undefined ? null : { periodId: holding.period.id, from: holding.period.from, to: holding.period.to };
  };
  const byId = new Map(drafts.map((draft) => [draft.id, draft]));
  // What only the server can see (an unknown customer, a day over 24 hours), asked again on every read.
  const draftProblems = async (draft: TimesheetLineDraft | null): Promise<readonly TimesheetLineProblem[]> =>
    draft === null || draft.date === null || timesheetLineProblems(draft.date, draft.typed).length > 0
      ? []
      : serverProblems(context, id, draft.id, draft.date, draft.typed);
  const lines: WorkingTimesheetLine[] = await Promise.all(
    entries.map(async (entry) => {
      const submitted = submittedOf(entry.id);
      // A submitted line is shown as submitted; a draft left over it (never possible once it is submitted) is not.
      const draft = submitted === null ? byId.get(entry.id) ?? null : null;
      return lineOf(entry, draft, submitted, await draftProblems(draft));
    }),
  );
  const entryIds = new Set(entries.map((entry) => entry.id));
  for (const draft of drafts) {
    if (!entryIds.has(draft.id)) lines.push(lineOf(null, draft, null, await draftProblems(draft)));
  }
  const completedRanges = (await lockedRanges(context, id, 'timesheet')).filter((range) => range.why === 'completed');
  const completedOf = (date: IsoDate | null) => {
    const range = date === null ? undefined : completedRanges.find((candidate) => candidate.from <= date && date <= candidate.to);
    return range === undefined ? null : { from: range.from, to: range.to };
  };
  return lines.map((line) => ({ ...line, completed: completedOf(line.date) })).sort(
    (a, b) => (a.date ?? '9999-99-99').localeCompare(b.date ?? '9999-99-99') || (a.entry?.updatedAt ?? a.revision).localeCompare(b.entry?.updatedAt ?? b.revision),
  );
};

export interface TimesheetLineInput {
  readonly id: string;
  readonly date: string | null;
  readonly typed: TimesheetLineTyped;
  /** The revision the screen was showing; null for a line it added. */
  readonly expectedRevision: string | null;
}

/** The rules only the server can apply to a line the browser thinks is complete. */
const serverProblems = async (
  context: OperationContext,
  userId: UserId,
  lineId: string,
  date: string,
  typed: TimesheetLineTyped,
): Promise<readonly TimesheetLineProblem[]> => {
  const problems: TimesheetLineProblem[] = [];
  const chosen = typed.pick.length > 0 && typed.pick !== WORKSHOP_PICK;
  if (chosen && (await context.repos.customers.findById(typed.pick as never)) === null) {
    problems.push({ field: 'customer', message: 'Customer: that customer is not in the register any more — choose again, or type the name.' });
  }
  const sameDay = (await context.repos.attendance.listEntries(userId, date, date)).filter((entry) => entry.id !== lineId);
  const dayHours =
    sameDay.reduce((total, entry) => total + entry.normalHours + entry.overtimeHours + entry.doubleHours, 0) +
    parseTyped(typed.overtime) + parseTyped(typed.double);
  if (dayHours > TIMESHEET_MAX_HOURS_PER_DAY + 1e-9) {
    problems.push({ field: 'overtime', message: `The lines for ${formatDayAndDate(date)} would add up to ${Math.round(dayHours * 100) / 100} hours — more than 24.` });
  }
  return problems;
};

/**
 * SAVE ONE LINE AS TYPED: complete → the stored line; not complete → its
 * draft. Returns the line as the screen should now show it.
 */
const saveLineHeld = async (
  context: OperationContext,
  technicianId: string,
  input: TimesheetLineInput,
): Promise<WorkingTimesheetLine> => {
  const userId = asUserId(technicianId);
  assertOwner(context, userId);
  const [entry, draft] = await Promise.all([
    context.repos.attendance.findEntry(input.id),
    context.repos.attendance.findLineDraft(input.id),
  ]);
  // Somebody else's line is refused exactly like one that does not exist.
  if ((entry !== null && entry.userId !== userId) || (draft !== null && draft.userId !== userId)) {
    throw refuse('That timesheet line does not exist.', 'entry_not_found', 'Reload the timesheet.');
  }
  if (entry === null && draft === null && !UUID.test(input.id)) {
    throw refuse('That timesheet line does not exist.', 'entry_not_found', 'Reload the timesheet.');
  }
  const held = entry === null ? null : (await currentSubmittedLines(context, userId)).find(({ entries }) => entries.some((line) => line.id === entry.id));
  if (held !== undefined && held !== null) {
    throw refuse(
      `This line is part of your submitted timesheet for ${formatPeriod(held.period.from, held.period.to)}.`,
      'timesheet_line_submitted',
      'A submitted timesheet is kept exactly as submitted. To change it, open it under Corrections on My Monthly Forms and ask for a correction.',
    );
  }
  const date = input.date === null || input.date === '' ? null : input.date;
  const shownDate = draft !== null ? draft.date : entry?.date ?? null;
  const shownTyped = draft?.typed ?? (entry === null ? null : typedOfEntry(entry));
  const revision = draft?.updatedAt ?? entry?.updatedAt ?? null;
  // Saying again what the line already says is never a conflict: a retry after a lost answer succeeds.
  if (shownTyped !== null && shownDate === date && sameTypedLine(shownTyped, input.typed)) {
    const known = draft === null || date === null || timesheetLineProblems(date, input.typed).length > 0
      ? []
      : await serverProblems(context, userId, input.id, date, input.typed);
    return lineOf(entry, draft, null, known);
  }
  // FORM-LIFECYCLE-1: a completed timesheet's dates are locked — kept as a draft or as a line alike. A submitted
  // timesheet's are not (REPEAT-DATES-1): its LINES are held, refused above; a new line on its date is the next sheet's.
  await assertDatesOpen(context, userId, 'timesheet', [date]);
  await assertDatesOpen(context, userId, 'timesheet', [shownDate, entry?.date].filter((left) => left !== date), { leaving: true });
  if ((input.expectedRevision ?? null) !== revision) {
    throw refuse(
      'This line was changed somewhere else since you opened it.',
      'timesheet_line_changed',
      'The newer version is shown. Make your change again on it.',
    );
  }

  const browserProblems = timesheetLineProblems(date, input.typed);
  const onlyServer = browserProblems.length === 0 ? await serverProblems(context, userId, input.id, date!, input.typed) : [];
  const problems = [...browserProblems, ...onlyServer];
  // Strictly later than the revision being replaced: two saves in one millisecond never share a revision.
  const now = laterThan(context.services.clock.now(), revision);

  if (problems.length > 0) {
    const kept: TimesheetLineDraft = {
      id: input.id,
      userId,
      date: date !== null && /^\d{4}-\d{2}-\d{2}$/u.test(date) ? date : null,
      // Exactly the seven typed fields — nothing else is stored.
      typed: {
        pick: input.typed.pick,
        customerName: input.typed.customerName,
        overtime: input.typed.overtime,
        double: input.typed.double,
        callout: input.typed.callout,
        internalKm: input.typed.internalKm,
        customerKm: input.typed.customerKm,
      },
      updatedBy: context.actor.id,
      updatedAt: now,
    };
    if (draft === null) {
      await audit(context, {
        jobId: null,
        type: 'timesheet_entry_draft',
        summary: `Timesheet line kept as a draft: ${userFullName(context.actor)}'s timesheet${kept.date === null ? '' : ` for ${kept.date}`}`,
        detail: `Not complete yet — ${problems.map((problem) => problem.message).join(' ')}`,
      });
    }
    const saved = await context.repos.attendance.saveLineDraft(kept);
    return lineOf(entry, saved, null, onlyServer);
  }

  const workshop = input.typed.pick === WORKSHOP_PICK;
  const stored = await saveTimesheetEntry(
    context,
    technicianId,
    {
      ...(entry === null ? {} : { entryId: entry.id }),
      date: date!,
      customerId: workshop || input.typed.pick.length === 0 ? null : input.typed.pick,
      customerName: workshop ? '' : input.typed.customerName,
      workshop,
      overtimeHours: parseTyped(input.typed.overtime),
      doubleHours: parseTyped(input.typed.double),
      calloutAmount: randToCents(input.typed.callout),
      // TS-CALLOUT-2: the Shared tick is gone; a line written before keeps what it stored.
      calloutShared: entry?.calloutShared ?? false,
      internalKm: parseTyped(input.typed.internalKm),
      customerKm: parseTyped(input.typed.customerKm),
    },
    { newId: input.id, updatedAt: now, alwaysWrite: draft !== null },
  );
  if (draft !== null) await context.repos.attendance.deleteLineDraft(draft.id);
  return lineOf(stored, null, null);
};

/**
 * REMOVE ONE LINE — the stored line and any draft of it. Asked again after it
 * is gone, it changes nothing and says so (a retried tap is not an error).
 */
const removeLineHeld = async (
  context: OperationContext,
  technicianId: string,
  lineId: string,
): Promise<{ readonly removed: boolean }> => {
  const userId = asUserId(technicianId);
  assertOwner(context, userId);
  const [entry, draft] = await Promise.all([
    context.repos.attendance.findEntry(lineId),
    context.repos.attendance.findLineDraft(lineId),
  ]);
  const mine = (row: { readonly userId: UserId } | null) => row !== null && row.userId === userId;
  const removal = { id: lineId, userId, removedBy: context.actor.id, removedAt: context.services.clock.now() };
  if (!mine(entry) && !mine(draft)) {
    // Nothing here (yet): the line's first save may still be on its way. The removal is recorded, so that
    // save is refused when it arrives — unless the id is somebody else's, which is left exactly alone.
    if (entry === null && draft === null && UUID.test(lineId)) await context.repos.attendance.recordLineRemoval(removal);
    return { removed: false };
  }
  if (mine(entry)) {
    const held = (await currentSubmittedLines(context, userId)).find(({ entries }) => entries.some((line) => line.id === lineId));
    if (held !== undefined && mine(draft)) {
      // Only the unfinished typing over it goes; the submitted line stays exactly as submitted.
      await context.repos.attendance.deleteLineDraft(lineId);
      return { removed: true };
    }
    if (held !== undefined) {
      throw refuse(
        `This line is part of your submitted timesheet for ${formatPeriod(held.period.from, held.period.to)}.`,
        'timesheet_line_submitted',
        'A submitted timesheet is kept exactly as submitted. To change it, ask for a correction under Corrections on My Monthly Forms.',
      );
    }
    await removeTimesheetEntry(context, technicianId, lineId);
  }
  if (mine(draft)) {
    await context.repos.attendance.deleteLineDraft(lineId);
    if (!mine(entry)) {
      await audit(context, {
        jobId: null,
        type: 'timesheet_entry_removed',
        summary: `Incomplete timesheet line removed: ${userFullName(context.actor)}'s timesheet${draft!.date === null ? '' : ` for ${draft!.date}`}`,
        detail: 'It was never complete, so it was never on the timesheet.',
      });
    }
  }
  // A removed line stays removed: a save of it still on its way, or from another device, is refused (0053).
  await context.repos.attendance.recordLineRemoval(removal);
  return { removed: true };
};

/** A save refused because the line was removed: what the person typed, said back to them. */
const describeTyped = (date: string | null, typed: TimesheetLineTyped): string =>
  [
    date === null ? 'no date' : formatDayAndDate(date),
    typed.pick === WORKSHOP_PICK ? 'Workshop' : typed.customerName.trim() || 'no customer',
    `OT ${typed.overtime || '0'}`,
    `D/T ${typed.double || '0'}`,
    `call-out R${typed.callout || '0'}`,
    `Int Km ${typed.internalKm || '0'}`,
    `Cust Km ${typed.customerKm || '0'}`,
  ].join(', ');

/**
 * SAVE ONE LINE AS TYPED — one at a time per line (the line's lock, held for
 * the request), and never a line its owner removed: a save that arrives after
 * the removal (still on its way, or from another device) is refused, saying
 * what was typed, instead of writing the line back.
 */
export const saveTimesheetLine = async (
  context: OperationContext,
  technicianId: string,
  input: TimesheetLineInput,
): Promise<WorkingTimesheetLine> => {
  assertOwner(context, asUserId(technicianId));
  const release = await context.repos.attendance.lockLine(input.id);
  try {
    const removed = await context.repos.attendance.findLineRemoval(input.id);
    const back = removed === null ? false : (await context.repos.attendance.findEntry(input.id)) !== null || (await context.repos.attendance.findLineDraft(input.id)) !== null;
    // A line that exists again after its removal (written back by an earlier release after a rollback) is simply the line now.
    if (removed !== null && removed.userId === context.actor.id && !back) {
      throw refuse(
        'This line was removed, so the change was not saved.',
        'timesheet_line_removed',
        `It was removed ${removed.removedAt.slice(0, 16).replace('T', ' ')} (on this or another device). What was typed: ${describeTyped(input.date, input.typed)}. Add it again as a new line if it is still needed.`,
      );
    }
    return await saveLineHeld(context, technicianId, input);
  } finally {
    release();
  }
};

/** REMOVE ONE LINE — under the same lock as its saves, so a removal and a save never interleave. */
export const removeTimesheetLine = async (
  context: OperationContext,
  technicianId: string,
  lineId: string,
): Promise<{ readonly removed: boolean }> => {
  assertOwner(context, asUserId(technicianId));
  const release = await context.repos.attendance.lockLine(lineId);
  try {
    return await removeLineHeld(context, technicianId, lineId);
  } finally {
    release();
  }
};
