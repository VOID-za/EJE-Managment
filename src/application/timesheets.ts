import {
  TIMESHEET_COMMENT_LIMIT,
  asUserId,
  can,
  userFullName,
  type AttendanceStatus,
  type Customer,
  type IsoDate,
  type Job,
  type TimesheetComment,
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
 * A TECHNICIAN'S TIMESHEET. TIMESHEET-1.
 *
 * Date, customer, overtime, double time, call-out and the day's comment — and
 * normal time beside them, because a timesheet that hid the ordinary hours
 * would invite somebody to add them up again elsewhere.
 *
 * WHERE EACH NUMBER COMES FROM, so that nothing is counted twice or invented:
 *
 *   - HOURS are the technician's own labour lines (`LabourEntry`) on every job,
 *     summed by day and customer. They are READ: the timesheet stores no hours
 *     of its own, so the job card and the timesheet cannot disagree, and a line
 *     corrected on the job is corrected here.
 *   - CALL-OUT is the job's own `calloutApplied` — the fixed fee for attending.
 *     The job records it once and gives it no date and no technician, so the
 *     timesheet shows it once per job per technician who worked on it, on that
 *     technician's FIRST day of labour on the job (their attendance). It is a
 *     count of call-outs, never a sum of money, and it is never repeated on a
 *     second day of the same job.
 *   - THE DAY'S COMMENT is the one thing the system did not hold, so it is the
 *     one new record (`TimesheetComment`): one per person per day.
 *   - ATTENDANCE, where the register has a record for the day, is shown for
 *     reference and changes nothing here.
 */

const refuse = (message: string, code: string, detail: string): WorkflowError =>
  new WorkflowError(message, [{ code, message: detail }]);

/** The longest range one timesheet covers: a quarter. Longer is a report. */
export const TIMESHEET_MAX_DAYS = 92;

/** Somebody whose timesheet can be opened, as the picker shows them. */
export type TimesheetPerson = Pick<User, 'id' | 'firstName' | 'lastName' | 'role' | 'jobTitle'>;

export interface TimesheetRow {
  readonly date: IsoDate;
  /** Null on a day with a comment and no labour. */
  readonly customerId: string | null;
  readonly customerName: string;
  readonly jobNumbers: readonly string[];
  readonly normalHours: number;
  readonly overtimeHours: number;
  readonly doubleHours: number;
  readonly callouts: number;
  /** The day's comment, carried on the day's FIRST row only. */
  readonly comment: string;
  readonly attendance: AttendanceStatus | null;
  /** True on the first row of a day, so a screen can group by day. */
  readonly firstOfDay: boolean;
}

export interface TimesheetTotals {
  readonly normalHours: number;
  readonly overtimeHours: number;
  readonly doubleHours: number;
  readonly callouts: number;
}

export interface Timesheet {
  readonly technician: Pick<User, 'id' | 'firstName' | 'lastName' | 'role' | 'jobTitle'>;
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly rows: readonly TimesheetRow[];
  readonly totals: TimesheetTotals;
  /** Every day in the range that has a comment, for editing on the screen. */
  readonly comments: readonly TimesheetComment[];
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * The timesheet rows, from the records. Pure: the same inputs always give the
 * same sheet, which is what lets it be tested line by line.
 */
export const buildTimesheetRows = (input: {
  readonly technicianId: UserId;
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly jobs: readonly Job[];
  readonly customers: readonly Customer[];
  readonly comments: readonly TimesheetComment[];
  readonly attendance: ReadonlyMap<IsoDate, AttendanceStatus>;
}): { rows: TimesheetRow[]; totals: TimesheetTotals } => {
  const { technicianId, from, to } = input;
  const customerName = new Map(input.customers.map((customer) => [customer.id as string, customer.name]));

  interface Cell {
    date: IsoDate;
    customerId: string;
    jobNumbers: Set<string>;
    normal: number;
    overtime: number;
    double: number;
    callouts: number;
  }
  const cells = new Map<string, Cell>();
  const cellFor = (date: IsoDate, customerId: string): Cell => {
    const key = `${date}|${customerId}`;
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = { date, customerId, jobNumbers: new Set(), normal: 0, overtime: 0, double: 0, callouts: 0 };
      cells.set(key, cell);
    }
    return cell;
  };

  for (const job of input.jobs) {
    const own = job.labour.filter((line) => line.technicianId === technicianId);
    if (own.length === 0) continue;

    for (const line of own) {
      if (line.date < from || line.date > to) continue;
      const cell = cellFor(line.date, job.customerId);
      cell.jobNumbers.add(job.jobNumber);
      if (line.rateType === 'overtime') cell.overtime += line.hours;
      else if (line.rateType === 'double') cell.double += line.hours;
      else cell.normal += line.hours;
    }

    // ONE call-out per job per technician, on their first day on the job —
    // whether or not that day is in the range, so a sheet for the second week
    // of a job does not show the call-out a second time.
    if (job.calloutApplied) {
      const first = own.reduce((earliest, line) => (line.date < earliest ? line.date : earliest), own[0]!.date);
      if (first >= from && first <= to) {
        const cell = cellFor(first, job.customerId);
        cell.jobNumbers.add(job.jobNumber);
        cell.callouts += 1;
      }
    }
  }

  const commentOn = new Map(
    input.comments
      .filter((comment) => comment.date >= from && comment.date <= to)
      .map((comment) => [comment.date, comment.comment]),
  );
  const days = new Set<IsoDate>([...[...cells.values()].map((cell) => cell.date), ...commentOn.keys()]);

  const rows: TimesheetRow[] = [];
  for (const date of [...days].sort()) {
    const dayCells = [...cells.values()]
      .filter((cell) => cell.date === date)
      .sort((a, b) =>
        (customerName.get(a.customerId) ?? '').localeCompare(customerName.get(b.customerId) ?? ''),
      );
    const comment = commentOn.get(date) ?? '';
    const attendance = input.attendance.get(date) ?? null;
    if (dayCells.length === 0) {
      rows.push({
        date,
        customerId: null,
        customerName: '',
        jobNumbers: [],
        normalHours: 0,
        overtimeHours: 0,
        doubleHours: 0,
        callouts: 0,
        comment,
        attendance,
        firstOfDay: true,
      });
      continue;
    }
    dayCells.forEach((cell, index) => {
      rows.push({
        date,
        customerId: cell.customerId,
        customerName: customerName.get(cell.customerId) ?? 'Unknown customer',
        jobNumbers: [...cell.jobNumbers].sort(),
        normalHours: round2(cell.normal),
        overtimeHours: round2(cell.overtime),
        doubleHours: round2(cell.double),
        callouts: cell.callouts,
        comment: index === 0 ? comment : '',
        attendance,
        firstOfDay: index === 0,
      });
    });
  }

  const totals: TimesheetTotals = {
    normalHours: round2(rows.reduce((sum, row) => sum + row.normalHours, 0)),
    overtimeHours: round2(rows.reduce((sum, row) => sum + row.overtimeHours, 0)),
    doubleHours: round2(rows.reduce((sum, row) => sum + row.doubleHours, 0)),
    callouts: rows.reduce((sum, row) => sum + row.callouts, 0),
  };
  return { rows, totals };
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
  const [jobs, customers, comments, records] = await Promise.all([
    context.repos.jobs.list(),
    context.repos.customers.list(),
    context.repos.attendance.listComments(id, from, to),
    context.repos.attendance.listRecords(from, to, id),
  ]);
  const { rows, totals } = buildTimesheetRows({
    technicianId: id,
    from,
    to,
    jobs,
    customers,
    comments,
    attendance: new Map(records.map((record) => [record.date, record.status])),
  });
  return {
    technician: {
      id: technician.id,
      firstName: technician.firstName,
      lastName: technician.lastName,
      role: technician.role,
      jobTitle: technician.jobTitle,
    },
    from,
    to,
    rows,
    totals,
    comments,
  };
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

const hours = (value: number): string => (value === 0 ? '' : value.toFixed(2));

const TIMESHEET_COLUMNS: readonly CsvColumn<TimesheetRow>[] = [
  { header: 'Date', value: (row) => row.date },
  { header: 'Customer', value: (row) => row.customerName },
  { header: 'Jobs', value: (row) => row.jobNumbers.join(' ') },
  { header: 'Normal', value: (row) => hours(row.normalHours) },
  { header: 'OT', value: (row) => hours(row.overtimeHours) },
  { header: 'Dblt', value: (row) => hours(row.doubleHours) },
  { header: 'Callout', value: (row) => (row.callouts === 0 ? '' : String(row.callouts)) },
  { header: 'Comments', value: (row) => row.comment },
  {
    header: 'Attendance',
    value: (row) =>
      row.firstOfDay && row.attendance !== null
        ? row.attendance === 'present'
          ? 'Present'
          : 'Absent'
        : '',
  },
];

export const timesheetExportColumns = TIMESHEET_COLUMNS.map((column) => column.header);

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
  return {
    fileName: csvFileName(stem, to),
    csv: toCsv(TIMESHEET_COLUMNS, sheet.rows),
    rowCount: sheet.rows.length,
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
): Promise<readonly Pick<User, 'id' | 'firstName' | 'lastName' | 'role' | 'jobTitle'>[]> => {
  const pick = (user: User) => ({
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    jobTitle: user.jobTitle,
  });
  if (!can(context.actor.role, 'timesheets.viewAll')) return [pick(context.actor)];
  const users = await context.repos.users.list();
  return users
    .filter((user) => user.active && user.role === 'technician')
    .sort((a, b) => a.firstName.localeCompare(b.firstName) || a.lastName.localeCompare(b.lastName))
    .map(pick);
};
