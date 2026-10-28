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
  userFullName,
  type AbsenceReason,
  type AttendanceRecord,
  type AttendanceStatus,
  type IsoDate,
  type IsoDateTime,
  type TimesheetComment,
  type TimesheetEntry,
  type TimesheetPeriod,
  type User,
  type UserId,
} from '@/domain';
import { businessToday } from '@/lib/business-time';
import { csvFileName, toCsv, type CsvColumn } from '@/lib/csv';
import { formatCurrency } from '@/lib/format';
import { formatPeriod, weekdayOf } from '@/lib/timesheet-dates';
import type { OperationContext } from './context';
import { audit, notifyOffice } from './audit';
import { WorkflowError } from './errors';
import { assertRecordableDate, isCalendarDate } from './attendance-operations';

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
 *   - SEND TO OFFICE (TS-02, TS-03, TS-14): a period is sent once. From then on
 *     the technician cannot add, correct or remove a line on any day inside it,
 *     nor change its comment — refused here on every path, and the database
 *     refuses a change to the sent row. Two sent periods never overlap, so no
 *     day's work is sent twice. The office is notified, and reads the
 *     submitted version. There is no reopening; a correction is a separate,
 *     audited process.
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

/** The longest range one timesheet view covers: a quarter. Longer is a report. */
export const TIMESHEET_MAX_DAYS = 92;

export type TimesheetPerson = Pick<User, 'id' | 'firstName' | 'lastName' | 'role' | 'jobTitle'>;

export interface TimesheetDay {
  readonly date: IsoDate;
  /** "Mon" — the day of the week, from the calendar date (TS-05). */
  readonly weekday: string;
  /** True when the technician has entered at least one line for the day. */
  readonly recorded: boolean;
  /** True when the day is inside a period already sent to the office: read-only. */
  readonly locked: boolean;
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
  /** Sent periods: every day inside one is read-only. */
  readonly lockedRanges?: readonly { readonly from: IsoDate; readonly to: IsoDate }[];
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

/** Office: anybody's timesheet. Everybody else: their own and nobody else's. */
const assertMayRead = (context: OperationContext, technicianId: UserId): void => {
  if (can(context.actor.role, 'timesheets.viewAll')) return;
  if (context.actor.id === technicianId) return;
  throw refuse(
    'You can only open your own timesheet.',
    'not_permitted',
    'The office reads every technician’s timesheet; a technician reads their own.',
  );
};

/** Only the technician whose timesheet it is enters or corrects it. */
const assertOwner = (context: OperationContext, technicianId: UserId): void => {
  if (context.actor.id === technicianId) return;
  throw refuse(
    'You can only enter your own timesheet.',
    'not_permitted',
    'Each technician keeps their own timesheet. The office reads and exports it.',
  );
};

const assertRange = (from: string, to: string): void => {
  if (!isCalendarDate(from) || !isCalendarDate(to)) {
    throw refuse('That is not a date range.', 'invalid_date', 'Give both days as YYYY-MM-DD.');
  }
  if (from > to) {
    throw refuse('The range ends before it starts.', 'invalid_range', 'Choose a From on or before the To.');
  }
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  if (days > TIMESHEET_MAX_DAYS) {
    throw refuse(
      'That range is too long for one timesheet.',
      'range_too_long',
      `A timesheet covers at most ${TIMESHEET_MAX_DAYS} days.`,
    );
  }
};

/** A timesheet period: a valid From/To range that has ended by today. */
const assertPeriod = (context: OperationContext, from: string, to: string): void => {
  assertRange(from, to);
  const today = businessToday(new Date(context.services.clock.now()));
  if (to > today) {
    throw refuse(
      'That period has not ended yet.',
      'period_in_future',
      `Today is ${today}. Choose a To on or before today.`,
    );
  }
};

/**
 * A timesheet line for a day that has not happened. Its own sentence: the
 * shared date check speaks of attendance, which read wrongly here (found on
 * the live site, 28 October 2026).
 */
const assertTimesheetDate = (context: OperationContext, date: string): void => {
  const today = businessToday(new Date(context.services.clock.now()));
  if (isCalendarDate(date) && date > today) {
    throw refuse(
      'A timesheet line cannot be entered for a day that has not happened.',
      'date_in_future',
      `Today is ${today}. Enter the day on or after it happens.`,
    );
  }
  assertRecordableDate(date, today);
};

/**
 * SENT TO THE OFFICE MEANS READ-ONLY. TS-02. Asked of every write, for every
 * day the write touches — a correction that moves a line from one day to
 * another touches two. A day inside ANY sent period is refused.
 */
const assertDayOpen = async (context: OperationContext, technicianId: UserId, date: string): Promise<void> => {
  const sent = await context.repos.attendance.listSubmittedPeriods(technicianId, date, date);
  const period = sent[0];
  if (period !== undefined) {
    throw refuse(
      `The timesheet for ${formatPeriod(period.from, period.to)} has been sent to the office.`,
      'timesheet_submitted',
      'A timesheet sent to the office is read-only. A correction goes through the office’s separate, recorded process.',
    );
  }
};

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
  const [entries, comments, records, sent, exact] = await Promise.all([
    context.repos.attendance.listEntries(id, from, to),
    context.repos.attendance.listComments(id, from, to),
    context.repos.attendance.listRecords(from, to, id),
    context.repos.attendance.listSubmittedPeriods(id, from, to),
    context.repos.attendance.findPeriod(id, from, to),
  ]);
  const { days, totals } = buildTimesheetDays({
    from,
    to,
    entries,
    comments,
    attendance: new Map(records.map((record) => [record.date, record])),
    lockedRanges: sent.map((period) => ({ from: period.from, to: period.to })),
  });
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
      comment: exact?.comment ?? '',
      submittedAt: exact?.submittedAt ?? null,
      submittedByName: await nameOf(context, exact?.submittedBy ?? null),
      overlapsSent: sent
        .filter((period) => period.id !== exact?.id)
        .map((period) => ({ from: period.from, to: period.to })),
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

const HOURS_STEP = 0.25;

const assertHours = (label: string, value: number, code: string): void => {
  if (!Number.isFinite(value) || value < 0 || value > TIMESHEET_MAX_HOURS_PER_DAY) {
    throw refuse(`${label} must be between 0 and 24 hours.`, code, `Enter ${label.toLowerCase()} as hours, 0 to 24.`);
  }
  if (Math.abs(value / HOURS_STEP - Math.round(value / HOURS_STEP)) > 1e-9) {
    throw refuse(`${label} must be in quarter hours.`, code, 'Use steps of 0.25 hours (15 minutes).');
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
  const calloutShared = input.calloutShared === true;
  if (calloutShared && calloutAmount === 0) {
    throw refuse(
      'A shared call-out needs its amount.',
      'callout_shared_without_amount',
      'Enter the call-out amount, or untick Shared.',
    );
  }
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
  const anything =
    normalHours + input.overtimeHours + input.doubleHours + callouts + calloutAmount + internalKm + customerKm > 0;
  if (anything && !workshop && customerName.length === 0) {
    throw refuse(
      'Say which customer the work was for, or choose Workshop.',
      'customer_required',
      'Choose a customer or Workshop for any line with hours, a call-out or kilometres.',
    );
  }

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

/** No day of the period may already be inside a DIFFERENT sent period. */
const assertNoOverlap = async (
  context: OperationContext,
  technicianId: UserId,
  from: string,
  to: string,
): Promise<void> => {
  const sent = await context.repos.attendance.listSubmittedPeriods(technicianId, from, to);
  const exact = sent.find((period) => period.from === from && period.to === to);
  if (exact !== undefined) {
    throw refuse(
      `The timesheet for ${formatPeriod(from, to)} has already been sent to the office.`,
      'timesheet_submitted',
      'It was sent once; the office has it.',
    );
  }
  const other = sent[0];
  if (other !== undefined) {
    throw refuse(
      `Part of ${formatPeriod(from, to)} was already sent to the office (${formatPeriod(other.from, other.to)}).`,
      'period_overlaps_submitted',
      'Choose From and To dates that do not include a day already sent, so no work is sent twice.',
    );
  }
};

/**
 * SAVE: the one comment for the whole timesheet period. TS-10, TS-12. The
 * owner only, for a period that has ended and shares no day with a sent one.
 * An unchanged comment writes nothing. Saving is never a submission.
 */
export const saveTimesheetPeriodComment = async (
  context: OperationContext,
  technicianId: string,
  from: string,
  to: string,
  text: string,
): Promise<TimesheetPeriod> => {
  const id = asUserId(technicianId);
  assertOwner(context, id);
  assertPeriod(context, from, to);
  const comment = text.trim();
  if (comment.length > TIMESHEET_PERIOD_COMMENT_LIMIT) {
    throw refuse(
      'That comment is too long.',
      'comment_too_long',
      `Keep it to ${TIMESHEET_PERIOD_COMMENT_LIMIT} characters.`,
    );
  }
  await assertNoOverlap(context, id, from, to);
  const existing = await context.repos.attendance.findPeriod(id, from, to);
  if (existing !== null && existing.comment === comment) return existing;

  const saved = await context.repos.attendance.savePeriodComment({
    id: existing?.id ?? context.services.ids.next('tsp'),
    userId: id,
    from,
    to,
    comment,
    updatedBy: context.actor.id,
    updatedAt: context.services.clock.now(),
    submittedAt: null,
    submittedBy: null,
    snapshot: null,
  });
  if (saved === null) {
    // Sent from another tab between the check and the write.
    await assertNoOverlap(context, id, from, to);
    throw refuse('The comment could not be saved.', 'comment_not_saved', 'Reload the timesheet.');
  }
  await audit(context, {
    jobId: null,
    type: 'timesheet_comment_saved',
    summary: `Timesheet comment ${existing === null || existing.comment === '' ? 'added' : 'changed'}: ${userFullName(context.actor)}'s timesheet for ${formatPeriod(from, to)}`,
    detail: `Written by ${userFullName(context.actor)}.`,
    changes: [{ field: 'Comment', from: existing?.comment ?? '', to: comment }],
  });
  return saved;
};

/**
 * SEND TO OFFICE. TS-02, TS-03, TS-14 — for the period the technician chose.
 *
 * The owner sends one period, once. What is sent is FROZEN in the submission:
 * every line inside the period and the comment, exactly as they stand. It may
 * not share a day with a period already sent, so no work is sent twice —
 * checked here, and again by the database's trigger. The repository sets the
 * submission only where none exists, so a double tap, a retry or two tabs
 * produce one submission and one refusal.
 *
 * THE OFFICE IS TOLD AFTER, AND ONLY AFTER, THE SUBMISSION IS SAVED: every
 * active Master and Coordinator, through the existing in-app notifications
 * (`notifyOffice`). A refused send notifies nobody, and a replayed request is
 * answered from the idempotency store without running this again — so a
 * double click never notifies twice. Audited with who and when.
 */
export const submitTimesheetPeriod = async (
  context: OperationContext,
  technicianId: string,
  from: string,
  to: string,
): Promise<TimesheetPeriod> => {
  const id = asUserId(technicianId);
  assertOwner(context, id);
  assertPeriod(context, from, to);
  await assertNoOverlap(context, id, from, to);
  const technician = await findTechnician(context, id);
  const [entries, existing] = await Promise.all([
    context.repos.attendance.listEntries(id, from, to),
    context.repos.attendance.findPeriod(id, from, to),
  ]);
  const now = context.services.clock.now();
  const comment = existing?.comment ?? '';
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
    // Another send for an overlapping period got there first (the database's guard).
    if (cause instanceof Error && /overlaps a period already sent/u.test(`${cause.message} ${String((cause as { cause?: unknown }).cause ?? '')}`)) {
      await assertNoOverlap(context, id, from, to);
    }
    throw cause;
  }
  if (saved === null) {
    throw refuse(
      `The timesheet for ${formatPeriod(from, to)} has already been sent to the office.`,
      'timesheet_submitted',
      'It was sent once; the office has it.',
    );
  }
  const label = formatPeriod(from, to);
  await audit(context, {
    jobId: null,
    type: 'timesheet_submitted',
    summary: `Timesheet sent to the office: ${userFullName(technician)}, ${label}`,
    detail: `${entries.length} line${entries.length === 1 ? '' : 's'} sent by ${userFullName(context.actor)}. Read-only from now on.`,
  });
  await notifyOffice(context, {
    type: 'timesheet_submitted',
    title: `${userFullName(technician)} sent a timesheet to the office`,
    body: `Period: ${label}\n${entries.length} line${entries.length === 1 ? '' : 's'}. Open Timesheets, choose ${userFullName(technician)} and these dates to read the version that was sent.`,
    link: '/timesheets',
  });
  return saved;
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
  readonly from: IsoDate;
  readonly to: IsoDate;
  /** "Thu 1 Oct 2026 – Wed 28 Oct 2026". */
  readonly periodLabel: string;
  /** Every day of the period, oldest first; several rows for a day of several lines. */
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
  readonly submittedByName: string | null;
  /** Absence reasons from the register, for days absent (reference only). */
  readonly absences: readonly { readonly date: IsoDate; readonly reason: string }[];
}

/** The document's rows from a period's lines. Pure. */
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
    if (lines.length === 0) {
      return [{
        date, weekday: weekdayOf(date), customer: 'NOT RECORDED', recorded: false,
        overtimeHours: null, doubleHours: null, calloutAmount: null, calloutShared: false,
        internalKm: null, customerKm: null, historicalNormalHours: 0, historicalCallouts: 0,
      }];
    }
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
): Promise<TimesheetDocument> => {
  const id = asUserId(technicianId);
  assertMayRead(context, id);
  assertRange(from, to);
  const technician = await findTechnician(context, id);
  const [row, records, settings] = await Promise.all([
    context.repos.attendance.findPeriod(id, from, to),
    context.repos.attendance.listRecords(from, to, id),
    context.repos.settings.get(),
  ]);
  const snapshot = row?.submittedAt != null ? row.snapshot : null;
  const entries = snapshot !== null ? snapshot.entries : await context.repos.attendance.listEntries(id, from, to);
  const rows = buildTimesheetDocumentRows(from, to, entries);
  const total = (pick: (r: TimesheetDocumentRow) => number | null): number =>
    rows.reduce((acc, r) => acc + (pick(r) ?? 0), 0);
  return {
    companyName: settings.companyName,
    technicianName: snapshot !== null ? snapshot.technicianName : userFullName(technician),
    from,
    to,
    periodLabel: formatPeriod(from, to),
    rows,
    comment: snapshot !== null ? snapshot.comment : row?.comment ?? '',
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
    absences: records
      .filter((record) => record.status === 'absent')
      .map((record) => ({
        date: record.date,
        reason: record.absenceReason === null ? 'Absent (reason not recorded)' : ABSENCE_REASON_LABELS[record.absenceReason],
      })),
  };
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
    }));
  });

/** The same sheet as a spreadsheet, for the office's records. */
export const exportTimesheet = async (
  context: OperationContext,
  technicianId: string,
  from: string,
  to: string,
): Promise<{ fileName: string; csv: string; rowCount: number; columns: readonly string[] }> => {
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
 * Whose timesheets this person may open: every technician for the office, and
 * only themselves for anybody else. The screen's picker is built from this,
 * and `loadTimesheet` asks again for every sheet.
 */
export const listTimesheetPeople = async (
  context: OperationContext,
): Promise<readonly TimesheetPerson[]> => {
  if (!can(context.actor.role, 'timesheets.viewAll')) return [personOf(context.actor)];
  const users = await context.repos.users.list();
  return users
    .filter((user) => user.active && user.role === 'technician')
    .sort((a, b) => a.firstName.localeCompare(b.firstName) || a.lastName.localeCompare(b.lastName))
    .map(personOf);
};
