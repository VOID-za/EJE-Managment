import {
  ABSENCE_REASON_LABELS,
  TIMESHEET_COMMENT_LIMIT,
  TIMESHEET_CUSTOMER_LIMIT,
  TIMESHEET_MAX_CALLOUT_CENTS,
  TIMESHEET_MAX_HOURS_PER_DAY,
  TIMESHEET_MAX_KM_PER_LINE,
  TIMESHEET_PERIOD_COMMENT_LIMIT,
  WORKSHOP_LABEL,
  asCustomerId,
  asUserId,
  can,
  completesTimesheet,
  userFullName,
  type AbsenceReason,
  type AttendanceRecord,
  type AttendanceStatus,
  type IsoDate,
  type IsoDateTime,
  type TimesheetComment,
  type TimesheetCorrection,
  type TimesheetCorrectionStatus,
  type TimesheetEntry,
  type TimesheetPeriod,
  type TimesheetSubmissionSnapshot,
  type User,
  type UserId,
} from '@/domain';
import { businessToday } from '@/lib/business-time';
import { csvFileName, toCsv, type CsvColumn } from '@/lib/csv';
import { formatCurrency } from '@/lib/format';
import { formatDayAndDate, formatPeriod, isTimesheetDay, weekdayOf } from '@/lib/timesheet-dates';
import { documentNameOf, timesheetPeriodFileName } from '@/lib/payroll-files';
import type { OperationContext } from './context';
import { audit, notifyOffice } from './audit';
import { WorkflowError } from './errors';
import { assertRecordableDate } from './attendance-operations';

/*
 * TS-PAPER (the owner, 4 November 2026): "stop treating Timesheets like a
 * complicated application and start treating it like a digital piece of
 * paper. The technician maintains it. The technician submits it on payday.
 * EJE records and preserves it." What that changed is in docs/timesheets-paper.md:
 * a line may be on any real date (no period, no future-date or 92-day rule),
 * with Workshop, a customer or neither; the open sheet is every line not yet
 * submitted; on payday the technician confirms From and To and submits; a
 * submission is never overwritten — a change after it is a correction.
 */

/**
 * A TECHNICIAN'S TIMESHEET — COMPLETELY MANUAL. TIMESHEET-2 (27 October 2026),
 * reshaped by the real-world reviewer on 28 October 2026 (TS-01 … TS-14).
 *
 * Every number on the sheet is a number the technician typed: the customer —
 * or Workshop — overtime (OT), double time (DT), the call-out as a rand amount,
 * internal and customer kilometres. Nothing is read from a job, a labour line,
 * an assignment or a call-out flag, and nothing is prefilled or recalculated.
 *
 * WHAT CHANGED ON 28 OCTOBER, AND WHAT DID NOT:
 *   - NT is no longer entered (TS-07). A line written before keeps its NT, shown
 *     as historical; it is never moved into OT or DT.
 *   - The call-out is an AMOUNT (TS-08). A line written before keeps its COUNT,
 *     shown as historical; a count is never turned into an amount. A call-out
 *     may be marked shared; the amount is not divided — no rule for that exists.
 *   - One comment for the whole timesheet (TS-10): the PERIOD's comment, which
 *     the PDF Layout prints in its Comments box. The day comments written
 *     before stay readable as history.
 *   - THE PERIOD IS CHOSEN (the owner, 28 October 2026): the technician's From
 *     and To dates, not a calendar month.
 *   - OVERLAPPING PERIODS (TS-OVERLAP-1, 3 November 2026): any From and To may
 *     be saved and sent, whatever was sent before. Sending a period that shares
 *     a day with an earlier CURRENT submission replaces it — the earlier one is
 *     marked superseded in the same unit of work, kept, and never shown — so
 *     the office reads exactly one current submission for any day, and the
 *     daily lines are never touched. (What follows is the history of the rule.)
 *   - SEND TO OFFICE (TS-02, TS-03, TS-14): a period is sent once. From then on
 *     the technician cannot add, correct or remove a line on any day inside it,
 *     nor change its comment — refused here on every path, and the database
 *     refuses a change to the sent row. Two sent periods never overlap, so no
 *     day's work is sent twice. The office is notified, and reads the
 *     submitted version. There is no reopening.
 *   - CORRECTING A SENT TIMESHEET (TS-16, 29 October 2026): the technician asks
 *     for a correction with a reason and the complete corrected lines; the
 *     office accepts or rejects it (`timesheet-corrections.ts`). The sent
 *     period and its snapshot are never changed. The version IN FORCE — what
 *     the sheet, the PDF Layout and the export show for those days — is the
 *     correction last accepted, or the original when none has been.
 *
 * WHO. A technician writes, corrects and removes their OWN lines, and only
 * theirs — the owner is taken from the session, never from the request. The
 * office (`timesheets.viewAll`) reads and exports everybody's but does not
 * write a technician's hours. Every write is on the audit trail.
 *
 * RECORDED AND UNRECORDED ARE DIFFERENT FACTS. A day with no line is
 * unrecorded; a line of zeros is a recorded day with no hours.
 */

const refuse = (message: string, code: string, detail: string): WorkflowError =>
  new WorkflowError(message, [{ code, message: detail }]);


export type TimesheetPerson = Pick<User, 'id' | 'firstName' | 'lastName' | 'role' | 'jobTitle'>;

export interface TimesheetDay {
  readonly date: IsoDate;
  /** "Mon" — the day of the week, from the calendar date (TS-05). */
  readonly weekday: string;
  /** True when the technician has entered at least one line for the day. */
  readonly recorded: boolean;
  /** True when the day is inside a period already sent to the office: read-only. */
  readonly locked: boolean;
  /**
   * For a sent day, which version of the sent timesheet its lines are:
   * "Sent — original" or "Sent — correction 2 accepted". Empty when not sent.
   */
  readonly sentVersion: string;
  readonly entries: readonly TimesheetEntry[];
  /** A day comment written before TS-10 (one comment per timesheet). History. */
  readonly comment: string;
  /** The attendance register's answer for the day, shown for reference only. */
  readonly attendance: AttendanceStatus | null;
  readonly absenceReason: AbsenceReason | null;
  readonly overtimeHours: number;
  readonly doubleHours: number;
  /** NT from lines written before TS-07. History; never entered now. */
  readonly normalHours: number;
  readonly calloutAmount: number;
  /** Call-out COUNTS from lines written before TS-08. History. */
  readonly callouts: number;
  readonly internalKm: number;
  readonly customerKm: number;
}

export interface TimesheetTotals {
  readonly overtimeHours: number;
  readonly doubleHours: number;
  readonly normalHours: number;
  readonly calloutAmount: number;
  readonly callouts: number;
  readonly internalKm: number;
  readonly customerKm: number;
  readonly recordedDays: number;
  readonly unrecordedDays: number;
}

/** The chosen period: its comment, and whether it — or any day inside it — was sent. */
export interface TimesheetPeriodState {
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly label: string;
  readonly comment: string;
  /** Set when exactly this period was sent to the office. */
  readonly submittedAt: IsoDateTime | null;
  readonly submittedByName: string | null;
  /** Other sent periods sharing days with this one: those days are read-only. */
  readonly overlapsSent: readonly { readonly from: IsoDate; readonly to: IsoDate }[];
  /** TS-16. Corrections of exactly this sent period, oldest first. */
  readonly corrections: readonly TimesheetCorrectionView[];
  /** "Original submission" or "Correction 2, accepted …": the version in force. Empty for a draft. */
  readonly versionInForce: string;
}

/** One correction as the screen shows it: who, when, why, the decision, and what changed. */
export interface TimesheetCorrectionView {
  readonly id: string;
  readonly sequence: number;
  readonly status: TimesheetCorrectionStatus;
  readonly reason: string;
  readonly requestedAt: IsoDateTime;
  readonly requestedById: UserId;
  readonly requestedByName: string | null;
  readonly decidedAt: IsoDateTime | null;
  readonly decidedByName: string | null;
  readonly decisionNote: string;
  readonly before: { readonly comment: string; readonly entries: readonly TimesheetEntry[] };
  readonly after: { readonly comment: string; readonly entries: readonly TimesheetEntry[] };
  /** Plain sentences, one per change, oldest day first. */
  readonly changes: readonly string[];
}

export interface Timesheet {
  readonly technician: TimesheetPerson;
  readonly from: IsoDate;
  readonly to: IsoDate;
  /** Every day in the range, OLDEST FIRST, recorded or not (TS-04). */
  readonly days: readonly TimesheetDay[];
  readonly totals: TimesheetTotals;
  /** The From/To period itself: what Save, Preview, Print and Send act on. */
  readonly period: TimesheetPeriodState;
  /** Whether the person reading it may enter and correct its lines (its owner). */
  readonly editable: boolean;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;
const round1 = (value: number): number => Math.round(value * 10) / 10;

const daysBetween = (from: string, to: string): readonly IsoDate[] => {
  const days: IsoDate[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let at = Date.parse(`${from}T00:00:00Z`); at <= end; at += 86_400_000) {
    days.push(new Date(at).toISOString().slice(0, 10));
  }
  return days;
};

const sum = (entries: readonly TimesheetEntry[], pick: (entry: TimesheetEntry) => number): number =>
  entries.reduce((total, entry) => total + pick(entry), 0);

/** The sheet's days from the technician's own lines. Pure. */
export const buildTimesheetDays = (input: {
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly entries: readonly TimesheetEntry[];
  readonly comments: readonly TimesheetComment[];
  readonly attendance: ReadonlyMap<IsoDate, Pick<AttendanceRecord, 'status' | 'absenceReason'>>;
  /** Sent periods: every day inside one is read-only, labelled with the version shown. */
  readonly lockedRanges?: readonly { readonly from: IsoDate; readonly to: IsoDate; readonly label?: string }[];
}): { readonly days: readonly TimesheetDay[]; readonly totals: TimesheetTotals } => {
  const comments = new Map(input.comments.map((comment) => [comment.date, comment.comment]));
  const days = daysBetween(input.from, input.to).map((date): TimesheetDay => {
    const entries = input.entries.filter((entry) => entry.date === date);
    const attendance = input.attendance.get(date);
    return {
      date,
      weekday: weekdayOf(date),
      recorded: entries.length > 0,
      locked: (input.lockedRanges ?? []).some((range) => range.from <= date && date <= range.to),
      sentVersion: (input.lockedRanges ?? []).find((range) => range.from <= date && date <= range.to)?.label ?? '',
      entries,
      comment: comments.get(date) ?? '',
      attendance: attendance?.status ?? null,
      absenceReason: attendance?.absenceReason ?? null,
      overtimeHours: round2(sum(entries, (entry) => entry.overtimeHours)),
      doubleHours: round2(sum(entries, (entry) => entry.doubleHours)),
      normalHours: round2(sum(entries, (entry) => entry.normalHours)),
      calloutAmount: sum(entries, (entry) => entry.calloutAmount),
      callouts: sum(entries, (entry) => entry.callouts),
      internalKm: round1(sum(entries, (entry) => entry.internalKm)),
      customerKm: round1(sum(entries, (entry) => entry.customerKm)),
    };
  });
  const total = (pick: (day: TimesheetDay) => number): number => days.reduce((acc, day) => acc + pick(day), 0);
  return {
    days,
    totals: {
      overtimeHours: round2(total((day) => day.overtimeHours)),
      doubleHours: round2(total((day) => day.doubleHours)),
      normalHours: round2(total((day) => day.normalHours)),
      calloutAmount: total((day) => day.calloutAmount),
      callouts: total((day) => day.callouts),
      internalKm: round1(total((day) => day.internalKm)),
      customerKm: round1(total((day) => day.customerKm)),
      recordedDays: days.filter((day) => day.recorded).length,
      unrecordedDays: days.filter((day) => !day.recorded).length,
    },
  };
};

/**
 * A COORDINATOR KEEPS NO TIMESHEET. TS-ROLE-1 (the tester, 1 November 2026):
 * refused before anything is read or written — entering a line, removing one,
 * a comment, sending a period, asking for a correction, opening their own
 * sheet — so no route or old screen can reach it. Their earlier lines, if any,
 * stay in the record untouched; the office can still read them.
 */
export const assertKeepsTimesheet = (context: OperationContext): void => {
  if (completesTimesheet(context.actor.role)) return;
  throw refuse(
    'The Office does not complete a timesheet.',
    'timesheet_not_required',
    'The Office works no overtime and keep no timesheet; only attendance. Senior Techs, Technicians and Apprentices complete both.',
  );
};

/** Office: anybody's timesheet. Everybody else: their own and nobody else's. */
const assertMayRead = (context: OperationContext, technicianId: UserId): void => {
  // Their own sheet is only for a role that keeps one (TS-ROLE-1).
  if (context.actor.id === technicianId) assertKeepsTimesheet(context);
  if (can(context.actor.role, 'timesheets.viewAll')) return;
  if (context.actor.id === technicianId) return;
  throw refuse(
    'You can only open your own timesheet.',
    'not_permitted',
    'The office reads every technician’s timesheet; a technician reads their own.',
  );
};

/** Only the technician whose timesheet it is enters or corrects it — and only a role that keeps one. */
const assertOwner = (context: OperationContext, technicianId: UserId): void => {
  if (context.actor.id === technicianId) {
    assertKeepsTimesheet(context);
    return;
  }
  throw refuse(
    'You can only enter your own timesheet.',
    'not_permitted',
    'Each technician keeps their own timesheet. The office reads and exports it.',
  );
};

const assertRange = (from: string, to: string): void => {
  if (!isTimesheetDay(from) || !isTimesheetDay(to)) {
    throw refuse('That is not a date range.', 'invalid_date', 'Give both days as YYYY-MM-DD.');
  }
  if (from > to) {
    throw refuse('The range ends before it starts.', 'invalid_range', 'Choose a From on or before the To.');
  }
  // TS-PAPER: no longest period — a pay period ends on the real payday.
};

/**
 * A timesheet period: a valid From/To range. MONTH-END-OFF-1 (2 November
 * 2026): it no longer has to have ended — a month is sent when its owner is
 * ready, and sending it again replaces it.
 */
const assertPeriod = (_context: OperationContext, from: string, to: string): void => {
  assertRange(from, to);
};

/**
 * A timesheet line's date: a real calendar day, and nothing more. TS-PAPER
 * (4 November 2026) removed the future-date rule and the rule that a line be
 * inside the period on screen — the technician records the day they mean.
 */
const assertTimesheetDate = (_context: OperationContext, date: string): void => {
  // A real day this century — malformed input, not a business rule.
  if (!isTimesheetDay(date)) {
    throw refuse('That is not a date.', 'invalid_date', 'Give the day as YYYY-MM-DD.');
  }
};

/**
 * A SENT TIMESHEET STAYS EDITABLE. RESUBMIT-1 (the tester, 2 November 2026):
 * "A timesheet must be saveable and submittable again at any time, even if
 * previously submitted." Was TS-02's read-only rule, which refused every write
 * to a day inside a sent period. The lines are the technician's working copy;
 * what the office reads is the version last SENT, and sending again replaces
 * it. Kept as a named step, so every write still passes one place.
 */
const assertDayOpen = async (_context: OperationContext, _technicianId: UserId, _date: string): Promise<void> => {};

const personOf = (user: User): TimesheetPerson => ({
  id: user.id,
  firstName: user.firstName,
  lastName: user.lastName,
  role: user.role,
  jobTitle: user.jobTitle,
});

const findTechnician = async (context: OperationContext, id: UserId): Promise<User> => {
  const technician = await context.repos.users.findById(id);
  if (technician === null) {
    throw refuse('That person is not a user of the system.', 'unknown_user', 'Choose a technician.');
  }
  return technician;
};

const nameOf = async (context: OperationContext, id: UserId | null): Promise<string | null> => {
  if (id === null) return null;
  const user = await context.repos.users.findById(id);
  return user === null ? null : userFullName(user);
};

/**
 * THE VERSION OF A SENT PERIOD IN FORCE. TS-16. The correction last accepted;
 * the original submission when none has been. Pending and rejected
 * corrections change nothing.
 */
export const versionInForce = (
  period: TimesheetPeriod,
  corrections: readonly TimesheetCorrection[],
): { readonly snapshot: TimesheetSubmissionSnapshot; readonly correction: TimesheetCorrection | null } => {
  const accepted = corrections
    .filter((correction) => correction.status === 'accepted')
    .sort((a, b) => b.sequence - a.sequence)[0];
  if (accepted !== undefined) return { snapshot: accepted.after, correction: accepted };
  if (period.snapshot === null) throw new Error(`timesheet period ${period.id} has not been sent`);
  return { snapshot: period.snapshot, correction: null };
};

const versionLabel = async (context: OperationContext, correction: TimesheetCorrection | null): Promise<string> => {
  if (correction === null) return 'Original submission';
  const by = await nameOf(context, correction.decidedBy);
  return `Correction ${correction.sequence}, accepted ${correction.decidedAt?.slice(0, 10) ?? ''}${by === null ? '' : ` by ${by}`}`;
};

/** A line in a sentence, for the list of changes and the audit trail. */
export const describeTimesheetLine = (entry: TimesheetEntry): string => describe(entry);

/**
 * WHAT A CORRECTION CHANGES, in sentences, oldest day first: every line taken
 * out, every line put in, and the comment. A line that is unchanged is not
 * mentioned; a changed line reads as the old one out and the new one in.
 */
export const describeCorrectionChanges = (
  before: Pick<TimesheetSubmissionSnapshot, 'comment' | 'entries'>,
  after: Pick<TimesheetSubmissionSnapshot, 'comment' | 'entries'>,
): readonly string[] => {
  const key = (entry: TimesheetEntry) => `${entry.date}|${describe(entry)}`;
  const remaining = new Map<string, number>();
  for (const entry of after.entries) remaining.set(key(entry), (remaining.get(key(entry)) ?? 0) + 1);
  const removed: TimesheetEntry[] = [];
  for (const entry of before.entries) {
    const count = remaining.get(key(entry)) ?? 0;
    if (count > 0) remaining.set(key(entry), count - 1);
    else removed.push(entry);
  }
  const kept = new Map<string, number>();
  for (const entry of before.entries) kept.set(key(entry), (kept.get(key(entry)) ?? 0) + 1);
  const added: TimesheetEntry[] = [];
  for (const entry of after.entries) {
    const count = kept.get(key(entry)) ?? 0;
    if (count > 0) kept.set(key(entry), count - 1);
    else added.push(entry);
  }
  const lines = [
    ...removed.map((entry) => ({ date: entry.date, order: 0, text: `${formatDayAndDate(entry.date)}: removed — ${describe(entry)}` })),
    ...added.map((entry) => ({ date: entry.date, order: 1, text: `${formatDayAndDate(entry.date)}: added — ${describe(entry)}` })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order);
  return [
    ...lines.map((line) => line.text),
    ...(before.comment === after.comment ? [] : [`Comment: “${before.comment || '—'}” → “${after.comment || '—'}”`]),
  ];
};

export const correctionView = async (
  context: OperationContext,
  correction: TimesheetCorrection,
): Promise<TimesheetCorrectionView> => ({
  id: correction.id,
  sequence: correction.sequence,
  status: correction.status,
  reason: correction.reason,
  requestedAt: correction.requestedAt,
  requestedById: correction.requestedBy,
  requestedByName: await nameOf(context, correction.requestedBy),
  decidedAt: correction.decidedAt,
  decidedByName: await nameOf(context, correction.decidedBy),
  decisionNote: correction.decisionNote,
  before: { comment: correction.before.comment, entries: correction.before.entries },
  after: { comment: correction.after.comment, entries: correction.after.entries },
  changes: describeCorrectionChanges(correction.before, correction.after),
});

export const loadTimesheet = async (
  context: OperationContext,
  technicianId: string,
  from: string,
  to: string,
): Promise<Timesheet> => {
  const id = asUserId(technicianId);
  assertMayRead(context, id);
  assertRange(from, to);
  const technician = await findTechnician(context, id);
  const [entries, comments, records, sent, stored] = await Promise.all([
    context.repos.attendance.listEntries(id, from, to),
    context.repos.attendance.listComments(id, from, to),
    context.repos.attendance.listRecords(from, to, id),
    context.repos.attendance.listSubmittedPeriods(id, from, to),
    context.repos.attendance.findPeriod(id, from, to),
  ]);
  /*
   * TS-OVERLAP-1: a submission a later one replaced is not "sent" any more as far
   * as this sheet is concerned — the office reads the later one. Shown as a draft
   * (its comment kept), so it can be sent again, which makes it current again.
   */
  const exact = stored !== null && (stored.supersededAt ?? null) !== null ? { ...stored, submittedAt: null, submittedBy: null } : stored;
  /*
   * THE VERSION IN FORCE for every sent day (TS-16): where a correction of its
   * period has been accepted, the day shows that correction's lines, not the
   * lines as they stood when it was sent. The sent snapshot is not touched.
   */
  const correctionsBySent = await Promise.all(sent.map((period) => context.repos.attendance.listCorrections(period.id)));
  let shown: readonly TimesheetEntry[] = entries;
  const lockedRanges = sent.map((period, index) => {
    const inForce = versionInForce(period, correctionsBySent[index] ?? []);
    if (inForce.correction !== null) {
      const inside = (date: string) => period.from <= date && date <= period.to;
      shown = [
        ...shown.filter((entry) => !inside(entry.date)),
        ...inForce.snapshot.entries.filter((entry) => inside(entry.date) && from <= entry.date && entry.date <= to),
      ];
    }
    return {
      from: period.from,
      to: period.to,
      label: inForce.correction === null ? 'Sent — original' : `Sent — correction ${inForce.correction.sequence} accepted`,
    };
  });
  const { days, totals } = buildTimesheetDays({
    from,
    to,
    entries: shown,
    comments,
    attendance: new Map(records.map((record) => [record.date, record])),
    lockedRanges,
  });
  const exactIndex = exact === null ? -1 : sent.findIndex((period) => period.id === exact.id);
  const exactCorrections = exactIndex < 0 ? [] : correctionsBySent[exactIndex] ?? [];
  const exactInForce = exactIndex < 0 || exact === null ? null : versionInForce(exact, exactCorrections);
  return {
    technician: personOf(technician),
    from,
    to,
    days,
    totals,
    period: {
      from,
      to,
      label: formatPeriod(from, to),
      comment: exactInForce?.snapshot.comment ?? exact?.comment ?? '',
      submittedAt: exact?.submittedAt ?? null,
      submittedByName: await nameOf(context, exact?.submittedBy ?? null),
      overlapsSent: sent
        .filter((period) => period.id !== exact?.id)
        .map((period) => ({ from: period.from, to: period.to })),
      corrections: await Promise.all(exactCorrections.map((correction) => correctionView(context, correction))),
      versionInForce: exactInForce === null ? '' : await versionLabel(context, exactInForce.correction),
    },
    editable: context.actor.id === id,
  };
};

export interface TimesheetEntryInput {
  /** Present to correct an existing line; absent to add one. */
  readonly entryId?: string | undefined;
  readonly date: string;
  readonly customerId?: string | null | undefined;
  readonly customerName: string;
  /** TS-06. Workshop instead of a customer. */
  readonly workshop?: boolean | undefined;
  /**
   * NT. TS-07: not entered on a new line. Accepted only as the value a line
   * already carries (a correction of a line written before), never changed.
   */
  readonly normalHours?: number | undefined;
  readonly overtimeHours: number;
  readonly doubleHours: number;
  /** The old call-out COUNT. Like NT: only the value the line already carries. */
  readonly callouts?: number | undefined;
  /** TS-08. The call-out amount in cents. */
  readonly calloutAmount?: number | undefined;
  readonly calloutShared?: boolean | undefined;
  /** TS-09. */
  readonly internalKm?: number | undefined;
  readonly customerKm?: number | undefined;
}

const assertHours = (label: string, value: number, code: string): void => {
  if (!Number.isFinite(value) || value < 0 || value > TIMESHEET_MAX_HOURS_PER_DAY) {
    throw refuse(`${label} must be between 0 and 24 hours.`, code, `Enter ${label.toLowerCase()} as hours, 0 to 24.`);
  }
  // Hundredths are what the column holds (TS-PAPER: no quarter-hour rule).
  if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) {
    throw refuse(`${label} takes two decimals at most.`, code, 'For example 1.5 or 2.25.');
  }
};

const assertKm = (label: string, value: number, code: string): void => {
  if (!Number.isFinite(value) || value < 0 || value > TIMESHEET_MAX_KM_PER_LINE) {
    throw refuse(`${label} must be between 0 and ${TIMESHEET_MAX_KM_PER_LINE} km.`, code, `Enter ${label.toLowerCase()} in kilometres.`);
  }
  if (Math.abs(value * 10 - Math.round(value * 10)) > 1e-9) {
    throw refuse(`${label} takes one decimal at most.`, code, 'For example 12.5.');
  }
};

/** What the customer column says: Workshop, the customer, or nothing. */
export const timesheetCustomerLabel = (entry: Pick<TimesheetEntry, 'workshop' | 'customerName'>): string =>
  entry.workshop ? WORKSHOP_LABEL : entry.customerName;

const describe = (entry: TimesheetEntry): string =>
  [
    timesheetCustomerLabel(entry) || '(no customer)',
    `OT ${entry.overtimeHours}`,
    `DT ${entry.doubleHours}`,
    `call-out ${formatCurrency(entry.calloutAmount)}${entry.calloutShared ? ' (shared)' : ''}`,
    `internal km ${entry.internalKm}`,
    `customer km ${entry.customerKm}`,
    ...(entry.normalHours > 0 ? [`NT ${entry.normalHours} (historical)`] : []),
    ...(entry.callouts > 0 ? [`call-outs ${entry.callouts} (historical)`] : []),
  ].join(', ');

/** A line's values once every rule has been applied: what is stored. */
export type TimesheetLineValues = Pick<
  TimesheetEntry,
  | 'customerId' | 'customerName' | 'workshop' | 'normalHours' | 'overtimeHours' | 'doubleHours'
  | 'callouts' | 'calloutAmount' | 'calloutShared' | 'internalKm' | 'customerKm'
>;

/**
 * THE RULES FOR ONE LINE, whatever writes it — the technician's own sheet or a
 * correction of a sent one (TS-16): NT and the old call-out count are history;
 * quarter hours; a call-out amount in whole cents; kilometres to one decimal;
 * Workshop or a customer, and one of them whenever anything is above zero.
 * `existing` is the line being corrected, whose history is carried unchanged.
 */
export const normaliseTimesheetLine = async (
  context: OperationContext,
  input: TimesheetEntryInput,
  existing: Pick<TimesheetEntry, 'normalHours' | 'callouts'> | null,
): Promise<TimesheetLineValues> => {
  /*
   * NT AND THE CALL-OUT COUNT ARE HISTORY. TS-07, TS-08. A new line carries
   * neither; a correction of a line written before keeps exactly what it had.
   * A request that tries to set either is refused rather than quietly ignored,
   * so a stale screen cannot believe it recorded NT.
   */
  const normalHours = existing?.normalHours ?? 0;
  if (input.normalHours !== undefined && input.normalHours !== normalHours) {
    throw refuse(
      'NT is no longer entered on a timesheet.',
      'nt_not_entered',
      'Enter overtime (OT) and double time (DT). NT already recorded on an older line is kept as it was.',
    );
  }
  const callouts = existing?.callouts ?? 0;
  if (input.callouts !== undefined && input.callouts !== callouts) {
    throw refuse(
      'Call-outs are entered as an amount now.',
      'callout_count_withdrawn',
      'Enter the call-out amount in rand.',
    );
  }

  assertHours('Overtime', input.overtimeHours, 'invalid_overtime_hours');
  assertHours('Double time', input.doubleHours, 'invalid_double_hours');
  const calloutAmount = input.calloutAmount ?? 0;
  if (!Number.isInteger(calloutAmount) || calloutAmount < 0 || calloutAmount > TIMESHEET_MAX_CALLOUT_CENTS) {
    throw refuse(
      'The call-out must be an amount in rand.',
      'invalid_callout_amount',
      `Enter rand and cents, up to ${formatCurrency(TIMESHEET_MAX_CALLOUT_CENTS)}.`,
    );
  }
  // TS-CALLOUT-2 (3 November 2026): the Shared tick is gone — the technician enters their own share.
  // A line written before keeps what it stored; a new one stores false.
  const calloutShared = input.calloutShared === true;
  const internalKm = input.internalKm ?? 0;
  const customerKm = input.customerKm ?? 0;
  assertKm('Internal km', internalKm, 'invalid_internal_km');
  assertKm('Customer km', customerKm, 'invalid_customer_km');

  const workshop = input.workshop === true;
  let customerName = input.customerName.trim();
  let customerId = null as TimesheetEntry['customerId'];
  const chosen = input.customerId !== undefined && input.customerId !== null && input.customerId.length > 0;
  if (workshop && (chosen || customerName.length > 0)) {
    throw refuse(
      'A line is either Workshop or a customer, not both.',
      'workshop_and_customer',
      'Choose Workshop, or choose the customer.',
    );
  }
  if (chosen) {
    const customer = await context.repos.customers.findById(asCustomerId(input.customerId!));
    if (customer === null) {
      throw refuse('That customer is not in the register.', 'unknown_customer', 'Choose the customer again, or type the name.');
    }
    customerId = customer.id;
    if (customerName.length === 0) customerName = customer.name;
  }
  if (workshop) customerName = '';
  if (customerName.length > TIMESHEET_CUSTOMER_LIMIT) {
    throw refuse('That customer name is too long.', 'customer_too_long', `Keep it to ${TIMESHEET_CUSTOMER_LIMIT} characters.`);
  }
  // TS-PAPER: a customer is never required — Workshop, a customer, or neither.

  return {
    customerId, customerName, workshop, normalHours, overtimeHours: input.overtimeHours,
    doubleHours: input.doubleHours, callouts, calloutAmount, calloutShared, internalKm, customerKm,
  };
};

/**
 * Adds a line to the technician's own timesheet, or corrects one of theirs.
 * Validated here, whatever the screen did: a calendar day not in the future,
 * in no period already sent to the office; quarter hours from 0 to 24 per value and
 * per day; a call-out amount in whole cents; kilometres to one decimal; and a
 * customer — or Workshop — whenever anything is above zero.
 */
export const saveTimesheetEntry = async (
  context: OperationContext,
  technicianId: string,
  input: TimesheetEntryInput,
): Promise<TimesheetEntry> => {
  const id = asUserId(technicianId);
  assertOwner(context, id);
  assertTimesheetDate(context, input.date);

  const existing = input.entryId === undefined ? null : await context.repos.attendance.findEntry(input.entryId);
  if (input.entryId !== undefined && (existing === null || existing.userId !== id)) {
    // Somebody else's line is refused exactly like a line that does not exist.
    throw refuse('That timesheet line does not exist.', 'entry_not_found', 'Reload the timesheet.');
  }
  await assertDayOpen(context, id, input.date);
  if (existing !== null && existing.date !== input.date) {
    await assertDayOpen(context, id, existing.date);
  }

  const values = await normaliseTimesheetLine(context, input, existing);
  const { normalHours, customerId, customerName, workshop, callouts, calloutAmount, calloutShared, internalKm, customerKm } = values;

  const sameDay = await context.repos.attendance.listEntries(id, input.date, input.date);
  const others = sameDay.filter((entry) => entry.id !== existing?.id);
  const dayHours =
    others.reduce((total, entry) => total + entry.normalHours + entry.overtimeHours + entry.doubleHours, 0) +
    normalHours + input.overtimeHours + input.doubleHours;
  if (dayHours > TIMESHEET_MAX_HOURS_PER_DAY + 1e-9) {
    throw refuse(
      'That day would have more than 24 hours.',
      'day_over_24_hours',
      `The lines for ${input.date} would add up to ${round2(dayHours)} hours.`,
    );
  }

  const entry: TimesheetEntry = {
    id: existing?.id ?? context.services.ids.next('tse'),
    userId: id,
    date: input.date,
    customerId,
    customerName,
    workshop,
    normalHours,
    overtimeHours: input.overtimeHours,
    doubleHours: input.doubleHours,
    callouts,
    calloutAmount,
    calloutShared,
    internalKm,
    customerKm,
    updatedBy: context.actor.id,
    updatedAt: context.services.clock.now(),
  };

  const same = (key: keyof TimesheetEntry): boolean => existing !== null && existing[key] === entry[key];
  const fields: readonly (keyof TimesheetEntry)[] = [
    'date', 'customerId', 'customerName', 'workshop', 'overtimeHours', 'doubleHours',
    'calloutAmount', 'calloutShared', 'internalKm', 'customerKm',
  ];
  if (existing !== null && fields.every(same)) return existing;

  const saved = await context.repos.attendance.saveEntry(entry);
  const subject = `${userFullName(context.actor)}'s timesheet for ${entry.date}`;
  const change = (field: string, from: string, to: string) => (from === to ? [] : [{ field, from, to }]);
  await audit(context, {
    jobId: null,
    type: existing === null ? 'timesheet_entry_added' : 'timesheet_entry_corrected',
    summary: `Timesheet line ${existing === null ? 'added' : 'corrected'}: ${subject}`,
    detail: describe(saved),
    changes:
      existing === null
        ? []
        : [
            ...change('Date', existing.date, saved.date),
            ...change('Customer', timesheetCustomerLabel(existing), timesheetCustomerLabel(saved)),
            ...change('OT', String(existing.overtimeHours), String(saved.overtimeHours)),
            ...change('DT', String(existing.doubleHours), String(saved.doubleHours)),
            ...change('Call-out', formatCurrency(existing.calloutAmount), formatCurrency(saved.calloutAmount)),
            ...change('Call-out shared', existing.calloutShared ? 'Yes' : 'No', saved.calloutShared ? 'Yes' : 'No'),
            ...change('Internal km', String(existing.internalKm), String(saved.internalKm)),
            ...change('Customer km', String(existing.customerKm), String(saved.customerKm)),
          ],
  });
  return saved;
};

/** Removes one of the technician's own lines. The removal, and what it held, are audited. */
export const removeTimesheetEntry = async (
  context: OperationContext,
  technicianId: string,
  entryId: string,
): Promise<void> => {
  const id = asUserId(technicianId);
  assertOwner(context, id);
  const existing = await context.repos.attendance.findEntry(entryId);
  if (existing === null || existing.userId !== id) {
    throw refuse('That timesheet line does not exist.', 'entry_not_found', 'Reload the timesheet.');
  }
  await assertDayOpen(context, id, existing.date);
  await context.repos.attendance.deleteEntry(existing.id);
  await audit(context, {
    jobId: null,
    type: 'timesheet_entry_removed',
    summary: `Timesheet line removed: ${userFullName(context.actor)}'s timesheet for ${existing.date}`,
    detail: describe(existing),
  });
};

/**
 * Writes, changes or clears a DAY's comment. TIMESHEET-1's per-day comment,
 * kept so the comments written before TS-10 stay correct and correctable; the
 * screen no longer offers it — the timesheet's comment is the period's
 * (`saveTimesheetPeriodComment`). Locked once a period holding the day is sent.
 */
export const saveTimesheetComment = async (
  context: OperationContext,
  technicianId: string,
  date: string,
  text: string,
): Promise<TimesheetComment | null> => {
  const id = asUserId(technicianId);
  assertMayRead(context, id);
  assertRecordableDate(date, businessToday(new Date(context.services.clock.now())));
  const comment = text.trim();
  if (comment.length > TIMESHEET_COMMENT_LIMIT) {
    throw refuse(
      'That comment is too long.',
      'comment_too_long',
      `Keep it to ${TIMESHEET_COMMENT_LIMIT} characters.`,
    );
  }
  const technician = await findTechnician(context, id);
  await assertDayOpen(context, id, date);

  const existing = await context.repos.attendance.findComment(id, date);
  if ((existing?.comment ?? '') === comment) return existing;

  const subject = `${userFullName(technician)}'s timesheet for ${date}`;
  if (comment.length === 0) {
    await context.repos.attendance.deleteComment(id, date);
    await audit(context, {
      jobId: null,
      type: 'timesheet_comment_saved',
      summary: `Timesheet comment cleared: ${subject}`,
      detail: `Cleared by ${userFullName(context.actor)}.`,
      changes: [{ field: 'Comment', from: existing?.comment ?? '', to: '' }],
    });
    return null;
  }

  const saved = await context.repos.attendance.saveComment({
    id: existing?.id ?? context.services.ids.next('tsc'),
    userId: id,
    date,
    comment,
    updatedBy: context.actor.id,
    updatedAt: context.services.clock.now(),
  });
  await audit(context, {
    jobId: null,
    type: 'timesheet_comment_saved',
    summary: `Timesheet comment ${existing === null ? 'added' : 'changed'}: ${subject}`,
    detail: `Written by ${userFullName(context.actor)}.`,
    changes: [{ field: 'Comment', from: existing?.comment ?? '', to: comment }],
  });
  return saved;
};



/**
 * SUBMIT TIMESHEET — on payday, for the From and To the technician confirms.
 * TS-PAPER (4 November 2026), on TS-02/TS-03/TS-14 and TS-OVERLAP-1.
 *
 * Every line dated From…To and the sheet's comment are frozen in an immutable
 * snapshot, with who submitted it and when. The period may be any length and
 * end on any day — the real payday. Lines dated outside it stay on the
 * technician's sheet for the next one, and the comment is cleared for it.
 *
 * A SUBMISSION IS NEVER OVERWRITTEN (was RESUBMIT-1, which replaced the
 * snapshot and deleted its corrections): the same dates submitted again are
 * refused — a change after submitting is a correction, decided by the office,
 * with the original kept.
 *
 * REPLACING NEVER DROPS A DAY (TS-PAPER-7, the owner, 4 November 2026). Dates
 * that share a day with an earlier current submission must cover EVERY day of
 * it — then, and only when the technician confirms it (`replace`), the new
 * submission replaces it for the office: the earlier one is kept, marked
 * replaced, its snapshot untouched. Dates that cover only part of it are
 * refused, naming it, because the days left outside would fall out of payroll
 * with nobody choosing that. The repository replaces only submissions the new
 * dates cover, so two submissions racing cannot drop a day either: a partial
 * one left standing makes the database refuse the overlap.
 *
 * THE OFFICE IS TOLD AFTER, AND ONLY AFTER, THE SUBMISSION IS SAVED (every
 * active Master and Coordinator, in-app). A refused submission notifies
 * nobody, and a replayed request is answered from the idempotency store.
 */
export const submitTimesheetPeriod = async (
  context: OperationContext,
  technicianId: string,
  from: string,
  to: string,
  options: { readonly notify?: boolean; readonly replace?: boolean } = {},
): Promise<TimesheetPeriod> => {
  const id = asUserId(technicianId);
  assertOwner(context, id);
  assertPeriod(context, from, to);
  const technician = await findTechnician(context, id);
  const [entries, existing, working, current] = await Promise.all([
    context.repos.attendance.listEntries(id, from, to),
    context.repos.attendance.findPeriod(id, from, to),
    context.repos.attendance.findWorkingComment(id),
    context.repos.attendance.listSubmittedPeriods(id, from, to),
  ]);
  if (existing !== null && existing.submittedAt !== null) {
    throw refuse(
      `You already submitted your timesheet for ${formatPeriod(from, to)}.`,
      'timesheet_already_submitted',
      'A submitted timesheet is kept exactly as it was sent. To change it, open it under Submitted timesheets and ask for a correction.',
    );
  }
  const overlapping = current.filter((period) => period.id !== existing?.id);
  const partial = overlapping.filter((period) => !(from <= period.from && period.to <= to));
  if (partial.length > 0) {
    const named = partial.map((period) => formatPeriod(period.from, period.to)).join('; ');
    throw refuse(
      `These dates cover only part of your submitted timesheet for ${named}.`,
      'timesheet_partial_overlap',
      `Submitting them would leave the rest of ${named} out of your submitted timesheets. Start after it ends, choose dates that cover all of it to replace it, or open it under Submitted timesheets and ask for a correction.`,
    );
  }
  // A correction lives on its submission, not on the sheet's lines: replacing a corrected (or
  // correction-pending) submission from the lines would quietly undo or orphan it.
  for (const period of overlapping) {
    if ((await context.repos.attendance.listCorrections(period.id)).length > 0) {
      throw refuse(
        `Your submitted timesheet for ${formatPeriod(period.from, period.to)} has a correction, so it cannot be replaced.`,
        'timesheet_replace_corrected',
        'Change it with another correction under Submitted timesheets, or choose dates that start after it ends.',
      );
    }
  }
  if (overlapping.length > 0 && options.replace !== true) {
    const named = overlapping.map((period) => `${formatPeriod(period.from, period.to)} (${period.snapshot?.entries.length ?? 0} line${period.snapshot?.entries.length === 1 ? '' : 's'})`).join('; ');
    throw refuse(
      `These dates would replace your submitted timesheet for ${named}.`,
      'timesheet_replace_unconfirmed',
      'Confirm that the new submission replaces it. The earlier one is kept exactly as it was submitted, marked replaced.',
    );
  }
  const now = context.services.clock.now();
  // The open sheet's comment; a comment saved on these exact dates before TS-PAPER otherwise.
  const comment = working !== null ? working.comment : existing?.comment ?? '';
  const replaced = await context.repos.attendance.supersedeOverlappingPeriods({
    userId: id,
    from,
    to,
    exceptId: existing?.id ?? null,
    at: now,
    by: context.actor.id,
  });
  let saved: TimesheetPeriod | null;
  try {
    saved = await context.repos.attendance.submitPeriod({
      id: existing?.id ?? context.services.ids.next('tsp'),
      userId: id,
      from,
      to,
      comment,
      updatedBy: existing?.updatedBy ?? context.actor.id,
      updatedAt: existing?.updatedAt ?? now,
      submittedAt: now,
      submittedBy: context.actor.id,
      snapshot: { technicianName: userFullName(technician), from, to, comment, entries },
    });
  } catch (cause) {
    // Another submission for overlapping dates got there in between (the database's guard): say so plainly.
    if (cause instanceof Error && /overlaps a period already sent/u.test(`${cause.message} ${String((cause as { cause?: unknown }).cause ?? '')}`)) {
      throw refuse('Another submission for these dates was being sent at the same time.', 'timesheet_send_conflict', 'Reload the timesheet and submit it again.');
    }
    throw cause;
  }
  if (saved === null) {
    throw refuse(
      `You already submitted your timesheet for ${formatPeriod(from, to)}.`,
      'timesheet_already_submitted',
      'It was submitted once; the office has it.',
    );
  }
  if (working !== null && working.comment !== '') {
    await context.repos.attendance.saveWorkingComment({ userId: id, comment: '', updatedBy: context.actor.id, updatedAt: now });
  }
  const label = formatPeriod(from, to);
  await audit(context, {
    jobId: null,
    type: 'timesheet_submitted',
    summary: `Timesheet submitted: ${userFullName(technician)}, ${label}`,
    detail: `${entries.length} line${entries.length === 1 ? '' : 's'} submitted by ${userFullName(context.actor)}.${comment === '' ? '' : ' With its comment.'}${replaced.length > 0 ? ` It replaces the overlapping submission${replaced.length === 1 ? '' : 's'} ${replaced.map((period) => formatPeriod(period.from, period.to)).join('; ')}, which ${replaced.length === 1 ? 'is' : 'are'} kept and which the office no longer reads.` : ''}`,
  });
  if (options.notify !== false) await notifyOffice(context, {
    type: 'timesheet_submitted',
    title: `${userFullName(technician)} submitted a timesheet`,
    body: `Period: ${label}\n${entries.length} line${entries.length === 1 ? '' : 's'}.${replaced.length > 0 ? ' It replaces an earlier submission for some of these days.' : ''} Open Timesheets → Submitted timesheets to read it.`,
    link: '/timesheets',
  });
  return saved;
};

const addDays = (iso: string, days: number): IsoDate =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** One line of the open sheet, and — when its date is inside a current submission it is not part of — which. */
export interface WorkingTimesheetEntry extends TimesheetEntry {
  readonly outsideSubmitted: { readonly from: IsoDate; readonly to: IsoDate } | null;
}

/** One submission as the lists show it. */
export interface TimesheetSubmissionView {
  readonly id: string;
  readonly technicianId: UserId;
  readonly technicianName: string;
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly label: string;
  readonly submittedAt: IsoDateTime;
  readonly submittedByName: string | null;
  readonly lineCount: number;
  /** False once a later submission for overlapping dates replaced it (TS-OVERLAP-1). */
  readonly current: boolean;
  readonly replacedAt: IsoDateTime | null;
  /** "Original submission" or "Correction 2, accepted …". */
  readonly versionInForce: string;
  readonly correctionPending: boolean;
}

/** THE TECHNICIAN'S OPEN SHEET. TS-PAPER. */
export interface WorkingTimesheet {
  readonly technician: TimesheetPerson;
  readonly editable: boolean;
  readonly today: IsoDate;
  /** Every line not part of a current submission, any date, oldest first. */
  readonly entries: readonly WorkingTimesheetEntry[];
  readonly comment: string;
  /** Day comments written before TS-10, on the open sheet's dates. History. */
  readonly dayComments: readonly { readonly date: IsoDate; readonly comment: string }[];
  /** The dates the page proposes for Submit: the day after the last submission, to today. */
  readonly suggested: { readonly from: IsoDate; readonly to: IsoDate };
  readonly lastSubmission: { readonly from: IsoDate; readonly to: IsoDate; readonly submittedAt: IsoDateTime } | null;
  /** This person's submissions, the latest first. */
  readonly submissions: readonly TimesheetSubmissionView[];
}

const submissionViews = async (
  context: OperationContext,
  periods: readonly TimesheetPeriod[],
): Promise<readonly TimesheetSubmissionView[]> => {
  const names = new Map<string, string | null>();
  const named = async (userId: UserId | null): Promise<string | null> => {
    if (userId === null) return null;
    if (!names.has(userId)) names.set(userId, await nameOf(context, userId));
    return names.get(userId) ?? null;
  };
  return Promise.all(
    periods.map(async (period): Promise<TimesheetSubmissionView> => {
      const corrections = await context.repos.attendance.listCorrections(period.id);
      const inForce = versionInForce(period, corrections);
      return {
        id: period.id,
        technicianId: period.userId,
        technicianName: period.snapshot?.technicianName ?? (await named(period.userId)) ?? '',
        from: period.from,
        to: period.to,
        label: formatPeriod(period.from, period.to),
        submittedAt: period.submittedAt!,
        submittedByName: await named(period.submittedBy),
        lineCount: inForce.snapshot.entries.length,
        current: (period.supersededAt ?? null) === null,
        replacedAt: period.supersededAt ?? null,
        versionInForce: await versionLabel(context, inForce.correction),
        correctionPending: corrections.some((correction) => correction.status === 'pending'),
      };
    }),
  );
};

/**
 * THE OPEN SHEET: every line the technician has written that is not part of a
 * current submission — any date, past or future — with the sheet's comment and
 * the dates Submit will propose. Read by the owner (and the office).
 */
export const loadWorkingTimesheet = async (context: OperationContext, technicianId: string): Promise<WorkingTimesheet> => {
  const id = asUserId(technicianId);
  assertMayRead(context, id);
  const technician = await findTechnician(context, id);
  const today = businessToday(new Date(context.services.clock.now()));
  const [entries, submitted, working, dayComments] = await Promise.all([
    context.repos.attendance.listEntries(id, '0001-01-01', '9999-12-31'),
    context.repos.attendance.listSubmissions(id),
    context.repos.attendance.findWorkingComment(id),
    context.repos.attendance.listComments(id, '0001-01-01', '9999-12-31'),
  ]);
  const current = submitted.filter((period) => (period.supersededAt ?? null) === null);
  // What each current submission holds now: the lines of its version in force.
  const held = await Promise.all(
    current.map(async (period) => ({
      period,
      ids: new Set(versionInForce(period, await context.repos.attendance.listCorrections(period.id)).snapshot.entries.map((entry) => entry.id)),
    })),
  );
  const open = entries
    .flatMap((entry): WorkingTimesheetEntry[] => {
      const covering = held.find(({ period }) => period.from <= entry.date && entry.date <= period.to);
      if (covering === undefined) return [{ ...entry, outsideSubmitted: null }];
      if (covering.ids.has(entry.id)) return [];
      return [{ ...entry, outsideSubmitted: { from: covering.period.from, to: covering.period.to } }];
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.updatedAt.localeCompare(b.updatedAt));
  const last = current.reduce<TimesheetPeriod | null>((latest, period) => (latest === null || period.to > latest.to ? period : latest), null);
  const from = last !== null ? addDays(last.to, 1) : open[0]?.date ?? today;
  const openDates = new Set(open.map((entry) => entry.date));
  return {
    technician: personOf(technician),
    editable: context.actor.id === id,
    today,
    entries: open,
    comment: working?.comment ?? '',
    dayComments: dayComments.filter((day) => openDates.has(day.date)).map((day) => ({ date: day.date, comment: day.comment })),
    suggested: { from, to: today >= from ? today : from },
    lastSubmission: last === null ? null : { from: last.from, to: last.to, submittedAt: last.submittedAt! },
    submissions: await submissionViews(context, submitted),
  };
};

/** SAVE the open sheet's one comment. The owner only; an unchanged comment writes nothing. */
export const saveWorkingTimesheetComment = async (
  context: OperationContext,
  technicianId: string,
  text: string,
): Promise<{ readonly comment: string }> => {
  const id = asUserId(technicianId);
  assertOwner(context, id);
  const comment = text.trim();
  if (comment.length > TIMESHEET_PERIOD_COMMENT_LIMIT) {
    throw refuse('That comment is too long.', 'comment_too_long', `Keep it to ${TIMESHEET_PERIOD_COMMENT_LIMIT} characters.`);
  }
  const existing = await context.repos.attendance.findWorkingComment(id);
  if ((existing?.comment ?? '') === comment) return { comment };
  await context.repos.attendance.saveWorkingComment({ userId: id, comment, updatedBy: context.actor.id, updatedAt: context.services.clock.now() });
  await audit(context, {
    jobId: null,
    type: 'timesheet_comment_saved',
    summary: `Timesheet comment ${(existing?.comment ?? '') === '' ? 'added' : comment === '' ? 'cleared' : 'changed'}: ${userFullName(context.actor)}'s open timesheet`,
    detail: `Written by ${userFullName(context.actor)}.`,
    changes: [{ field: 'Comment', from: existing?.comment ?? '', to: comment }],
  });
  return { comment };
};

/**
 * SUBMITTED TIMESHEETS, the latest first. The office (`timesheets.viewAll`):
 * everybody's, or one person's; anybody else: their own only.
 */
export const listTimesheetSubmissions = async (
  context: OperationContext,
  technicianId?: string,
): Promise<readonly TimesheetSubmissionView[]> => {
  if (technicianId === undefined) {
    const everybody = can(context.actor.role, 'timesheets.viewAll');
    return submissionViews(context, await context.repos.attendance.listSubmissions(everybody ? null : context.actor.id));
  }
  const id = asUserId(technicianId);
  assertMayRead(context, id);
  return submissionViews(context, await context.repos.attendance.listSubmissions(id));
};

/** A submitted period by its id, for somebody allowed to read it; refused like a missing one otherwise. */
const findSubmission = async (context: OperationContext, periodId: string): Promise<TimesheetPeriod> => {
  const period = await context.repos.attendance.findPeriodById(periodId);
  if (period === null || period.submittedAt === null) {
    throw refuse('That submitted timesheet does not exist.', 'submission_not_found', 'Reload the list.');
  }
  if (!can(context.actor.role, 'timesheets.viewAll') && period.userId !== context.actor.id) {
    throw refuse('That submitted timesheet does not exist.', 'submission_not_found', 'Reload the list.');
  }
  return period;
};

/** One row of the PDF Layout's table. */
export interface TimesheetDocumentRow {
  readonly date: IsoDate;
  readonly weekday: string;
  /** Workshop, the customer, or NOT RECORDED for a day with no line. */
  readonly customer: string;
  readonly recorded: boolean;
  readonly overtimeHours: number | null;
  readonly doubleHours: number | null;
  readonly calloutAmount: number | null;
  readonly calloutShared: boolean;
  readonly internalKm: number | null;
  readonly customerKm: number | null;
  /** History carried by a line written before 28 October 2026. */
  readonly historicalNormalHours: number;
  readonly historicalCallouts: number;
}

/** Everything the timesheet PDF Layout prints, and nothing else. PDF-01…03. */
export interface TimesheetDocument {
  /** The heading's company, from the settings — the office's own name. */
  readonly companyName: string;
  readonly technicianName: string;
  /** PAY-03. The file name downloads, prints and the Finance package use: "JC TIMESHEET OCT.pdf". */
  readonly fileName: string;
  readonly from: IsoDate;
  readonly to: IsoDate;
  /** "Thu 1 Oct 2026 – Wed 28 Oct 2026". */
  readonly periodLabel: string;
  /**
   * The RECORDED days of the period, oldest first; several rows for a day of
   * several lines. A day with no line is not printed (PDF-UNREC-1).
   */
  readonly rows: readonly TimesheetDocumentRow[];
  readonly comment: string;
  readonly totals: {
    readonly overtimeHours: number;
    readonly doubleHours: number;
    readonly calloutAmount: number;
    readonly internalKm: number;
    readonly customerKm: number;
    readonly historicalNormalHours: number;
    readonly historicalCallouts: number;
  };
  /** Null for a draft; the moment it was sent for a submitted period. */
  readonly submittedAt: IsoDateTime | null;
  /**
   * TS-16. Which version of a sent period this is — "Original submission",
   * "Correction 2, accepted 29 Oct 2026 by …", "Correction 3 — PENDING, not in
   * force" — and whether it is the version in force. Empty for a draft.
   */
  readonly versionLabel: string;
  readonly inForce: boolean;
  readonly submittedByName: string | null;
  /** Absence reasons from the register, for days absent (reference only). */
  readonly absences: readonly { readonly date: IsoDate; readonly reason: string }[];
}

/**
 * The document's rows from a period's lines. Pure.
 *
 * ONLY RECORDED DAYS (PDF-UNREC-1, the tester, 1 November 2026): a day with no
 * line is left off the document — no blank row, no "NOT RECORDED", no zero
 * hours. The totals are the sum of the lines, so they are unchanged; what was
 * sent (the snapshot) is unchanged; only what is printed for an empty day is.
 */
export const buildTimesheetDocumentRows = (
  from: IsoDate,
  to: IsoDate,
  entries: readonly TimesheetEntry[],
): readonly TimesheetDocumentRow[] =>
  daysBetween(from, to).flatMap((date): TimesheetDocumentRow[] => {
    const lines = entries
      .filter((entry) => entry.date === date)
      .slice()
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    return lines.map((entry) => ({
      date,
      weekday: weekdayOf(date),
      customer: timesheetCustomerLabel(entry) || '—',
      recorded: true,
      overtimeHours: entry.overtimeHours,
      doubleHours: entry.doubleHours,
      calloutAmount: entry.calloutAmount,
      calloutShared: entry.calloutShared,
      internalKm: entry.internalKm,
      customerKm: entry.customerKm,
      historicalNormalHours: entry.normalHours,
      historicalCallouts: entry.callouts,
    }));
  });

/**
 * THE TIMESHEET AS ITS PDF LAYOUT PRINTS IT, for the chosen period. TS-11,
 * TS-13, PDF-01…04.
 *
 * A SENT period is printed from its SNAPSHOT — exactly what was sent — so the
 * office's copy can never differ from what the technician sent. A draft is
 * printed from the lines inside the period as they stand. Reading it changes
 * nothing: Preview and Print never submit, lock or write anything.
 */
export const loadTimesheetDocument = async (
  context: OperationContext,
  technicianId: string,
  from: string,
  to: string,
  /** TS-16. 'current' (the version in force), 'original', or a correction's sequence. */
  version: 'current' | 'original' | number = 'current',
): Promise<TimesheetDocument> => {
  const id = asUserId(technicianId);
  assertMayRead(context, id);
  assertRange(from, to);
  const technician = await findTechnician(context, id);
  const [row, records, settings, working] = await Promise.all([
    context.repos.attendance.findPeriod(id, from, to),
    context.repos.attendance.listRecords(from, to, id),
    context.repos.settings.get(),
    context.repos.attendance.findWorkingComment(id),
  ]);
  const sentRow = row?.submittedAt != null ? row : null;
  const corrections = sentRow === null ? [] : await context.repos.attendance.listCorrections(sentRow.id);
  const inForce = sentRow === null ? null : versionInForce(sentRow, corrections);
  let snapshot: TimesheetSubmissionSnapshot | null = inForce?.snapshot ?? null;
  let versionText = '';
  let isInForce = true;
  if (inForce !== null && sentRow !== null) {
    if (version === 'original') {
      snapshot = sentRow.snapshot;
      isInForce = inForce.correction === null;
      versionText = isInForce ? 'Original submission' : 'Original submission — superseded by an accepted correction';
    } else if (typeof version === 'number') {
      const chosen = corrections.find((correction) => correction.sequence === version);
      if (chosen === undefined) {
        throw refuse('That correction does not exist.', 'correction_not_found', 'Reload the timesheet.');
      }
      snapshot = chosen.after;
      isInForce = inForce.correction?.id === chosen.id;
      versionText = isInForce
        ? await versionLabel(context, chosen)
        : chosen.status === 'pending'
          ? `Correction ${chosen.sequence} — PENDING the office's decision, not in force`
          : chosen.status === 'rejected'
            ? `Correction ${chosen.sequence} — REJECTED, not in force`
            : `Correction ${chosen.sequence} — superseded by a later accepted correction`;
    } else {
      versionText = await versionLabel(context, inForce.correction);
    }
  } else if (version !== 'current') {
    throw refuse('This timesheet has not been sent to the office.', 'timesheet_not_sent', 'Only a sent timesheet has versions.');
  }
  // TS-PAPER-8: a submission a later one replaced says so, whichever version of it is read.
  if (sentRow !== null && (sentRow.supersededAt ?? null) !== null) {
    versionText = `${versionText} — replaced by a later submission on ${sentRow.supersededAt!.slice(0, 10)}`;
  }
  const entries = snapshot !== null ? snapshot.entries : await context.repos.attendance.listEntries(id, from, to);
  const rows = buildTimesheetDocumentRows(from, to, entries);
  const total = (pick: (r: TimesheetDocumentRow) => number | null): number =>
    rows.reduce((acc, r) => acc + (pick(r) ?? 0), 0);
  return {
    companyName: settings.companyName,
    technicianName: snapshot !== null ? snapshot.technicianName : userFullName(technician),
    fileName: timesheetPeriodFileName(documentNameOf(technician), from, to),
    from,
    to,
    periodLabel: formatPeriod(from, to),
    rows,
    // A draft prints the open sheet's comment (TS-PAPER), or one saved on these dates before it.
    comment: snapshot !== null ? snapshot.comment : working !== null ? working.comment : row?.comment ?? '',
    totals: {
      overtimeHours: round2(total((r) => r.overtimeHours)),
      doubleHours: round2(total((r) => r.doubleHours)),
      calloutAmount: total((r) => r.calloutAmount),
      internalKm: round1(total((r) => r.internalKm)),
      customerKm: round1(total((r) => r.customerKm)),
      historicalNormalHours: round2(total((r) => r.historicalNormalHours)),
      historicalCallouts: total((r) => r.historicalCallouts),
    },
    submittedAt: snapshot !== null ? row!.submittedAt : null,
    submittedByName: snapshot !== null ? await nameOf(context, row!.submittedBy) : null,
    versionLabel: versionText,
    inForce: isInForce,
    absences: records
      .filter((record) => record.status === 'absent')
      .map((record) => ({
        date: record.date,
        reason: record.absenceReason === null ? 'Absent (reason not recorded)' : ABSENCE_REASON_LABELS[record.absenceReason],
      })),
  };
};

/** TS-PAPER. One submission as its PDF Layout prints it — current or replaced, any version. */
export const loadSubmissionDocument = async (
  context: OperationContext,
  periodId: string,
  version: 'current' | 'original' | number = 'current',
): Promise<TimesheetDocument> => {
  const period = await findSubmission(context, periodId);
  return loadTimesheetDocument(context, period.userId, period.from, period.to, version);
};

/** One spreadsheet row: a line, or an unrecorded day said as such. */
interface ExportRow {
  readonly date: IsoDate;
  readonly day: string;
  readonly customer: string;
  readonly overtime: string;
  readonly double: string;
  readonly callout: string;
  readonly shared: string;
  readonly internalKm: string;
  readonly customerKm: string;
  readonly normal: string;
  readonly callouts: string;
  readonly comment: string;
  readonly attendance: string;
  readonly sentVersion: string;
}

const hours = (value: number): string => value.toFixed(2);
const rand = (cents: number): string => (cents / 100).toFixed(2);

const TIMESHEET_COLUMNS: readonly CsvColumn<ExportRow>[] = [
  { header: 'Date', value: (row) => row.date },
  { header: 'Day', value: (row) => row.day },
  { header: 'Customer', value: (row) => row.customer },
  { header: 'OT', value: (row) => row.overtime },
  { header: 'D/T', value: (row) => row.double },
  { header: 'Callout (R)', value: (row) => row.callout },
  { header: 'Callout shared', value: (row) => row.shared },
  { header: 'Int Km', value: (row) => row.internalKm },
  { header: 'Cust Km', value: (row) => row.customerKm },
  // History: values entered before 28 October 2026 stay in the export.
  { header: 'NT (historical)', value: (row) => row.normal },
  { header: 'Callouts (historical count)', value: (row) => row.callouts },
  { header: 'Day comment (historical)', value: (row) => row.comment },
  { header: 'Attendance', value: (row) => row.attendance },
  // TS-16: a sent day says which version of the sent timesheet it shows.
  { header: 'Sent version', value: (row) => row.sentVersion },
];

export const timesheetExportColumns = TIMESHEET_COLUMNS.map((column) => column.header);

const attendanceText = (day: TimesheetDay): string => {
  if (day.attendance === null) return '';
  if (day.attendance === 'present') return 'Present';
  return day.absenceReason === null ? 'Absent' : `Absent — ${ABSENCE_REASON_LABELS[day.absenceReason]}`;
};

/** The rows of the export: every line as typed, and every unrecorded day marked NOT RECORDED. */
export const timesheetExportRows = (sheet: Pick<Timesheet, 'days'>): readonly ExportRow[] =>
  sheet.days.flatMap((day): ExportRow[] => {
    const attendance = attendanceText(day);
    if (!day.recorded) {
      return [{
        date: day.date, day: day.weekday, customer: 'NOT RECORDED', overtime: '', double: '', callout: '',
        shared: '', internalKm: '', customerKm: '', normal: '', callouts: '', comment: day.comment, attendance,
        sentVersion: day.sentVersion,
      }];
    }
    return day.entries.map((entry, index) => ({
      date: day.date,
      day: day.weekday,
      customer: timesheetCustomerLabel(entry),
      overtime: hours(entry.overtimeHours),
      double: hours(entry.doubleHours),
      callout: rand(entry.calloutAmount),
      shared: entry.calloutShared ? 'Yes' : '',
      internalKm: entry.internalKm.toFixed(1),
      customerKm: entry.customerKm.toFixed(1),
      normal: entry.normalHours > 0 ? hours(entry.normalHours) : '',
      callouts: entry.callouts > 0 ? String(entry.callouts) : '',
      comment: index === 0 ? day.comment : '',
      attendance: index === 0 ? attendance : '',
      sentVersion: day.sentVersion,
    }));
  });

/**
 * The same sheet as a spreadsheet, for the office's records — the OFFICE'S
 * ONLY since 1 November 2026: the tester removed Export CSV from the
 * technician's Timesheet page (TS-CSV-OFF-1), and the server agrees, so the
 * export exists only where the office reads somebody's sheet.
 */
export const exportTimesheet = async (
  context: OperationContext,
  technicianId: string,
  from: string,
  to: string,
): Promise<{ fileName: string; csv: string; rowCount: number; columns: readonly string[] }> => {
  if (!can(context.actor.role, 'timesheets.viewAll')) {
    throw refuse(
      'Only the office exports a timesheet as a spreadsheet.',
      'not_permitted',
      'Your timesheet can be previewed, printed and downloaded as its PDF.',
    );
  }
  const sheet = await loadTimesheet(context, technicianId, from, to);
  const stem = `eje-timesheet-${sheet.technician.firstName}-${sheet.technician.lastName}-${from}-to`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, '-');
  const rows = timesheetExportRows(sheet);
  return {
    fileName: csvFileName(stem, to),
    csv: toCsv(TIMESHEET_COLUMNS, rows),
    rowCount: rows.length,
    columns: timesheetExportColumns,
  };
};

/**
 * TS-PAPER. One submission as a spreadsheet — exactly the lines of its version
 * in force, one row a line — for the office's records (TS-CSV-OFF-1: the
 * office's only).
 */
export const exportTimesheetSubmission = async (
  context: OperationContext,
  periodId: string,
): Promise<{ fileName: string; csv: string; rowCount: number; columns: readonly string[] }> => {
  if (!can(context.actor.role, 'timesheets.viewAll')) {
    throw refuse(
      'Only the office exports a timesheet as a spreadsheet.',
      'not_permitted',
      'Your timesheet can be previewed, printed and downloaded as its PDF.',
    );
  }
  const period = await findSubmission(context, periodId);
  const inForce = versionInForce(period, await context.repos.attendance.listCorrections(period.id));
  const label = inForce.correction === null ? 'Sent — original' : `Sent — correction ${inForce.correction.sequence} accepted`;
  const { days } = buildTimesheetDays({
    from: period.from,
    to: period.to,
    entries: inForce.snapshot.entries,
    comments: [],
    attendance: new Map(),
    lockedRanges: [{ from: period.from, to: period.to, label }],
  });
  const rows = timesheetExportRows({ days: days.filter((day) => day.recorded) });
  const stem = `eje-timesheet-${inForce.snapshot.technicianName}-${period.from}-to`.toLowerCase().replace(/[^a-z0-9-]+/gu, '-');
  return { fileName: csvFileName(stem, period.to), csv: toCsv(TIMESHEET_COLUMNS, rows), rowCount: rows.length, columns: timesheetExportColumns };
};

/**
 * Whose timesheets this person may open, THEIR OWN FIRST: for the office, then
 * every other active user, whose sheets it reads (`timesheets.viewAll`) but
 * never writes (`assertOwner`); for anybody else, only themselves. The
 * screen's picker is built from this and opens on the first entry, and
 * `loadTimesheet` asks again for every sheet.
 *
 * TST-TS-2 #5 (the tester, 31 October 2026). This used to offer the office
 * technicians only, so a Master or a Coordinator could not fill in the
 * timesheet My Monthly Forms asks them to submit. Every user is listed after
 * them because EJE Monthly Forms covers every user's month, not only the
 * technicians'.
 */
export const listTimesheetPeople = async (
  context: OperationContext,
): Promise<readonly TimesheetPerson[]> => {
  // TS-ROLE-1: nobody lists a Coordinator's sheet — they keep none — and a
  // Coordinator is offered only the technicians' and Masters' sheets, to read.
  const own = completesTimesheet(context.actor.role) ? [personOf(context.actor)] : [];
  if (!can(context.actor.role, 'timesheets.viewAll')) return own;
  const users = await context.repos.users.list();
  const others = users
    .filter((user) => user.active && user.id !== context.actor.id && completesTimesheet(user.role))
    .sort((a, b) => a.firstName.localeCompare(b.firstName) || a.lastName.localeCompare(b.lastName))
    .map(personOf);
  return [...own, ...others];
};
