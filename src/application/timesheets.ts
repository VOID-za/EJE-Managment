import {
  TIMESHEET_COMMENT_LIMIT,
  TIMESHEET_CUSTOMER_LIMIT,
  TIMESHEET_MAX_CALLOUTS_PER_LINE,
  TIMESHEET_MAX_HOURS_PER_DAY,
  asCustomerId,
  asUserId,
  can,
  userFullName,
  type AttendanceStatus,
  type IsoDate,
  type TimesheetComment,
  type TimesheetEntry,
  type User,
  type UserId,
} from '@/domain';
import { businessToday } from '@/lib/business-time';
import { csvFileName, toCsv, type CsvColumn } from '@/lib/csv';
import type { OperationContext } from './context';
import { audit } from './audit';
import { WorkflowError } from './errors';
import { assertRecordableDate, isCalendarDate } from './attendance-operations';

/**
 * A TECHNICIAN'S TIMESHEET — COMPLETELY MANUAL. TIMESHEET-2, the owner's
 * instruction of 27 October 2026, replacing TIMESHEET-1's derived sheet.
 *
 * TIMESHEET-1 computed the hours from job labour and the call-out from the
 * job's flag. The owner has ruled that out: each technician maintains their own
 * timesheet, choosing the customer and typing normal time, overtime, double
 * time and call-outs for each day — day by day as the work happens, or all at
 * once later (the morning of payday). Both are the same operation here.
 *
 * WHAT THIS MODULE NEVER DOES: read a job, a labour line, an assignment or a
 * call-out flag; prefill a value; recalculate one; or overwrite what a
 * technician entered. Every number on the sheet is a number somebody typed.
 *
 * WHO. A technician writes, corrects and removes their OWN lines, and only
 * theirs — the owner is taken from the session, never from the request. The
 * office (`timesheets.viewAll`) reads and exports everybody's but does not
 * write a technician's hours for them. Every write is on the audit trail with
 * what changed.
 *
 * RECORDED AND UNRECORDED ARE DIFFERENT FACTS. A day with no line is
 * unrecorded. A line of zeros is a recorded day with no hours. Every screen and
 * the export keep them apart.
 */

const refuse = (message: string, code: string, detail: string): WorkflowError =>
  new WorkflowError(message, [{ code, message: detail }]);

/** The longest range one timesheet covers: a quarter. Longer is a report. */
export const TIMESHEET_MAX_DAYS = 92;

export type TimesheetPerson = Pick<User, 'id' | 'firstName' | 'lastName' | 'role' | 'jobTitle'>;

export interface TimesheetDay {
  readonly date: IsoDate;
  /** True when the technician has entered at least one line for the day. */
  readonly recorded: boolean;
  readonly entries: readonly TimesheetEntry[];
  readonly comment: string;
  /** The attendance register's answer for the day, shown for reference only. */
  readonly attendance: AttendanceStatus | null;
  readonly normalHours: number;
  readonly overtimeHours: number;
  readonly doubleHours: number;
  readonly callouts: number;
}

export interface TimesheetTotals {
  readonly normalHours: number;
  readonly overtimeHours: number;
  readonly doubleHours: number;
  readonly callouts: number;
  readonly recordedDays: number;
  readonly unrecordedDays: number;
}

export interface Timesheet {
  readonly technician: TimesheetPerson;
  readonly from: IsoDate;
  readonly to: IsoDate;
  /** Every day in the range, oldest first, recorded or not. */
  readonly days: readonly TimesheetDay[];
  readonly totals: TimesheetTotals;
  /** Whether the person reading it may enter and correct its lines (its owner). */
  readonly editable: boolean;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

const daysBetween = (from: string, to: string): readonly IsoDate[] => {
  const days: IsoDate[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let at = Date.parse(`${from}T00:00:00Z`); at <= end; at += 86_400_000) {
    days.push(new Date(at).toISOString().slice(0, 10));
  }
  return days;
};

/** The sheet's days from the technician's own lines. Pure. */
export const buildTimesheetDays = (input: {
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly entries: readonly TimesheetEntry[];
  readonly comments: readonly TimesheetComment[];
  readonly attendance: ReadonlyMap<IsoDate, AttendanceStatus>;
}): { readonly days: readonly TimesheetDay[]; readonly totals: TimesheetTotals } => {
  const comments = new Map(input.comments.map((comment) => [comment.date, comment.comment]));
  const days = daysBetween(input.from, input.to).map((date): TimesheetDay => {
    const entries = input.entries.filter((entry) => entry.date === date);
    return {
      date,
      recorded: entries.length > 0,
      entries,
      comment: comments.get(date) ?? '',
      attendance: input.attendance.get(date) ?? null,
      normalHours: round2(entries.reduce((sum, entry) => sum + entry.normalHours, 0)),
      overtimeHours: round2(entries.reduce((sum, entry) => sum + entry.overtimeHours, 0)),
      doubleHours: round2(entries.reduce((sum, entry) => sum + entry.doubleHours, 0)),
      callouts: entries.reduce((sum, entry) => sum + entry.callouts, 0),
    };
  });
  return {
    days,
    totals: {
      normalHours: round2(days.reduce((sum, day) => sum + day.normalHours, 0)),
      overtimeHours: round2(days.reduce((sum, day) => sum + day.overtimeHours, 0)),
      doubleHours: round2(days.reduce((sum, day) => sum + day.doubleHours, 0)),
      callouts: days.reduce((sum, day) => sum + day.callouts, 0),
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

/** Only the technician whose timesheet it is enters or corrects its lines. */
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
    throw refuse('The range ends before it starts.', 'invalid_range', 'Choose a start on or before the end.');
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

const personOf = (user: User): TimesheetPerson => ({
  id: user.id,
  firstName: user.firstName,
  lastName: user.lastName,
  role: user.role,
  jobTitle: user.jobTitle,
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
  const technician = await context.repos.users.findById(id);
  if (technician === null) {
    throw refuse('That person is not a user of the system.', 'unknown_user', 'Choose a technician.');
  }
  const [entries, comments, records] = await Promise.all([
    context.repos.attendance.listEntries(id, from, to),
    context.repos.attendance.listComments(id, from, to),
    context.repos.attendance.listRecords(from, to, id),
  ]);
  const { days, totals } = buildTimesheetDays({
    from,
    to,
    entries,
    comments,
    attendance: new Map(records.map((record) => [record.date, record.status])),
  });
  return {
    technician: personOf(technician),
    from,
    to,
    days,
    totals,
    editable: context.actor.id === id,
  };
};

export interface TimesheetEntryInput {
  /** Present to correct an existing line; absent to add one. */
  readonly entryId?: string | undefined;
  readonly date: string;
  readonly customerId?: string | null | undefined;
  readonly customerName: string;
  readonly normalHours: number;
  readonly overtimeHours: number;
  readonly doubleHours: number;
  readonly callouts: number;
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

const describe = (entry: Pick<TimesheetEntry, 'customerName' | 'normalHours' | 'overtimeHours' | 'doubleHours' | 'callouts'>): string =>
  `${entry.customerName || '(no customer)'} — NT ${entry.normalHours}, OT ${entry.overtimeHours}, DBL T ${entry.doubleHours}, call-outs ${entry.callouts}`;

/**
 * Adds a line to the technician's own timesheet, or corrects one of theirs.
 * Validated here, whatever the screen did: a calendar day not in the future,
 * quarter hours from 0 to 24 per value and per day, whole call-outs, and a
 * customer whenever anything is above zero.
 */
export const saveTimesheetEntry = async (
  context: OperationContext,
  technicianId: string,
  input: TimesheetEntryInput,
): Promise<TimesheetEntry> => {
  const id = asUserId(technicianId);
  assertOwner(context, id);
  assertRecordableDate(input.date, businessToday(new Date(context.services.clock.now())));

  assertHours('Normal time', input.normalHours, 'invalid_normal_hours');
  assertHours('Overtime', input.overtimeHours, 'invalid_overtime_hours');
  assertHours('Double time', input.doubleHours, 'invalid_double_hours');
  if (!Number.isInteger(input.callouts) || input.callouts < 0 || input.callouts > TIMESHEET_MAX_CALLOUTS_PER_LINE) {
    throw refuse('Call-outs must be a whole number.', 'invalid_callouts', `Enter 0 to ${TIMESHEET_MAX_CALLOUTS_PER_LINE}.`);
  }

  let customerName = input.customerName.trim();
  let customerId = null as TimesheetEntry['customerId'];
  if (input.customerId !== undefined && input.customerId !== null && input.customerId.length > 0) {
    const customer = await context.repos.customers.findById(asCustomerId(input.customerId));
    if (customer === null) {
      throw refuse('That customer is not in the register.', 'unknown_customer', 'Choose the customer again, or type the name.');
    }
    customerId = customer.id;
    if (customerName.length === 0) customerName = customer.name;
  }
  if (customerName.length > TIMESHEET_CUSTOMER_LIMIT) {
    throw refuse('That customer name is too long.', 'customer_too_long', `Keep it to ${TIMESHEET_CUSTOMER_LIMIT} characters.`);
  }
  const anything = input.normalHours + input.overtimeHours + input.doubleHours + input.callouts > 0;
  if (anything && customerName.length === 0) {
    throw refuse('Say which customer the work was for.', 'customer_required', 'Choose or type the customer for any line with hours or a call-out.');
  }

  const existing = input.entryId === undefined ? null : await context.repos.attendance.findEntry(input.entryId);
  if (input.entryId !== undefined && (existing === null || existing.userId !== id)) {
    // Somebody else's line is refused exactly like a line that does not exist.
    throw refuse('That timesheet line does not exist.', 'entry_not_found', 'Reload the timesheet.');
  }

  const sameDay = await context.repos.attendance.listEntries(id, input.date, input.date);
  const others = sameDay.filter((entry) => entry.id !== existing?.id);
  const dayHours =
    others.reduce((sum, entry) => sum + entry.normalHours + entry.overtimeHours + entry.doubleHours, 0) +
    input.normalHours + input.overtimeHours + input.doubleHours;
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
    normalHours: input.normalHours,
    overtimeHours: input.overtimeHours,
    doubleHours: input.doubleHours,
    callouts: input.callouts,
    updatedBy: context.actor.id,
    updatedAt: context.services.clock.now(),
  };

  if (
    existing !== null &&
    existing.date === entry.date &&
    existing.customerId === entry.customerId &&
    existing.customerName === entry.customerName &&
    existing.normalHours === entry.normalHours &&
    existing.overtimeHours === entry.overtimeHours &&
    existing.doubleHours === entry.doubleHours &&
    existing.callouts === entry.callouts
  ) {
    return existing;
  }

  const saved = await context.repos.attendance.saveEntry(entry);
  const subject = `${userFullName(context.actor)}'s timesheet for ${entry.date}`;
  await audit(context, {
    jobId: null,
    type: existing === null ? 'timesheet_entry_added' : 'timesheet_entry_corrected',
    summary: `Timesheet line ${existing === null ? 'added' : 'corrected'}: ${subject}`,
    detail: describe(saved),
    changes:
      existing === null
        ? []
        : [
            ...(existing.date === saved.date ? [] : [{ field: 'Date', from: existing.date, to: saved.date }]),
            ...(existing.customerName === saved.customerName ? [] : [{ field: 'Customer', from: existing.customerName, to: saved.customerName }]),
            ...(existing.normalHours === saved.normalHours ? [] : [{ field: 'NT', from: String(existing.normalHours), to: String(saved.normalHours) }]),
            ...(existing.overtimeHours === saved.overtimeHours ? [] : [{ field: 'OT', from: String(existing.overtimeHours), to: String(saved.overtimeHours) }]),
            ...(existing.doubleHours === saved.doubleHours ? [] : [{ field: 'DBL T', from: String(existing.doubleHours), to: String(saved.doubleHours) }]),
            ...(existing.callouts === saved.callouts ? [] : [{ field: 'Call-outs', from: String(existing.callouts), to: String(saved.callouts) }]),
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
  await context.repos.attendance.deleteEntry(existing.id);
  await audit(context, {
    jobId: null,
    type: 'timesheet_entry_removed',
    summary: `Timesheet line removed: ${userFullName(context.actor)}'s timesheet for ${existing.date}`,
    detail: describe(existing),
  });
};

/**
 * Writes, changes or clears the day's comment. The office for anybody, a
 * technician for their own days. An unchanged comment writes nothing.
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
  const technician = await context.repos.users.findById(id);
  if (technician === null) {
    throw refuse('That person is not a user of the system.', 'unknown_user', 'Choose a technician.');
  }

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

/** One spreadsheet row: a line, or an unrecorded day said as such. */
interface ExportRow {
  readonly date: IsoDate;
  readonly customer: string;
  readonly normal: string;
  readonly overtime: string;
  readonly double: string;
  readonly callouts: string;
  readonly comment: string;
  readonly attendance: string;
}

const hours = (value: number): string => value.toFixed(2);

const TIMESHEET_COLUMNS: readonly CsvColumn<ExportRow>[] = [
  { header: 'Date', value: (row) => row.date },
  { header: 'Customer', value: (row) => row.customer },
  { header: 'NT', value: (row) => row.normal },
  { header: 'OT', value: (row) => row.overtime },
  { header: 'DBL T', value: (row) => row.double },
  { header: 'Callout', value: (row) => row.callouts },
  { header: 'Comments', value: (row) => row.comment },
  { header: 'Attendance', value: (row) => row.attendance },
];

export const timesheetExportColumns = TIMESHEET_COLUMNS.map((column) => column.header);

/** The rows of the export: every line as typed, and every unrecorded day marked NOT RECORDED. */
export const timesheetExportRows = (sheet: Pick<Timesheet, 'days'>): readonly ExportRow[] =>
  sheet.days.flatMap((day): ExportRow[] => {
    const attendance = day.attendance === null ? '' : day.attendance === 'present' ? 'Present' : 'Absent';
    if (!day.recorded) {
      return [{ date: day.date, customer: 'NOT RECORDED', normal: '', overtime: '', double: '', callouts: '', comment: day.comment, attendance }];
    }
    return day.entries.map((entry, index) => ({
      date: day.date,
      customer: entry.customerName,
      normal: hours(entry.normalHours),
      overtime: hours(entry.overtimeHours),
      double: hours(entry.doubleHours),
      callouts: String(entry.callouts),
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
