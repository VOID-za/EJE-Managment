import { sql } from 'drizzle-orm';
import { boolean, check, date, index, integer, jsonb, numeric, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, instant, primaryId, rowVersion, updatedAt } from './columns';
import { users } from './identity';
import { customers } from './customers';

/**
 * THE ATTENDANCE REGISTER. ATTEND-1, migration 0033.
 *
 * ONE ROW PER PERSON PER DAY — `attendance_user_date_key` — so a second record
 * for the same day cannot exist however many writers race. A correction
 * UPDATES the row; its earlier value is on the audit trail.
 *
 * Separate from `availability` (planned leave) and from every job table, on
 * purpose: what was arranged, what happened and what was worked on are three
 * different records, and none of them writes another.
 */
export const attendance = pgTable(
  'attendance',
  {
    id: primaryId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    workDate: date('work_date').notNull(),
    status: text('status').notNull(),
    /** ATT-01, migration 0037. Null on a present day and on an absent day from before it. */
    absenceReason: text('absence_reason'),
    note: text('note').notNull().default(''),
    recordedBy: uuid('recorded_by')
      .notNull()
      .references(() => users.id),
    recordedAt: instant('recorded_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: rowVersion(),
  },
  (table) => [
    uniqueIndex('attendance_user_date_key').on(table.userId, table.workDate),
    index('attendance_date_idx').on(table.workDate),
    check('attendance_status_known', sql`${table.status} in ('present', 'absent')`),
    check('attendance_note_bounded', sql`char_length(${table.note}) <= 500`),
    check(
      'attendance_absence_reason_known',
      sql`${table.absenceReason} is null or (${table.status} = 'absent' and ${table.absenceReason} in ('leave', 'sick_leave', 'family_responsibility', 'iod'))`,
    ),
  ],
);

/**
 * A TECHNICIAN'S DAILY TIMESHEET COMMENT. TIMESHEET-1, migration 0033.
 *
 * The one part of a timesheet the system did not already hold: hours are the
 * labour lines on each job and the call-out is on the job, so neither is
 * copied here. One comment per person per day; a cleared comment is deleted,
 * and the clearing is audited.
 */
export const timesheetComments = pgTable(
  'timesheet_comments',
  {
    id: primaryId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    workDate: date('work_date').notNull(),
    comment: text('comment').notNull(),
    updatedBy: uuid('updated_by')
      .notNull()
      .references(() => users.id),
    commentedAt: instant('commented_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: rowVersion(),
  },
  (table) => [
    uniqueIndex('timesheet_comments_user_date_key').on(table.userId, table.workDate),
    check(
      'timesheet_comments_not_blank',
      sql`${table.comment} ~ '[^[:space:]]' and char_length(${table.comment}) <= 1000`,
    ),
  ],
);

/**
 * A technician's own timesheet lines. TIMESHEET-2 (27 October 2026): manual.
 *
 * Every value is what the technician typed; nothing here is derived from job
 * labour, call-out flags or assignments. Several lines may share a day (two
 * customers); a day with none is unrecorded. Hours in hundredths, 0 to 24.
 */
export const timesheetEntries = pgTable(
  'timesheet_entries',
  {
    id: primaryId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    workDate: date('work_date').notNull(),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'restrict' }),
    customerName: text('customer_name').notNull().default(''),
    normalHours: numeric('normal_hours', { precision: 5, scale: 2 }).notNull().default('0'),
    overtimeHours: numeric('overtime_hours', { precision: 5, scale: 2 }).notNull().default('0'),
    doubleHours: numeric('double_hours', { precision: 5, scale: 2 }).notNull().default('0'),
    callouts: integer('callouts').notNull().default(0),
    // Migration 0037: the reviewer's fields (TS-06, TS-08, TS-09).
    workshop: boolean('workshop').notNull().default(false),
    calloutAmountCents: integer('callout_amount_cents').notNull().default(0),
    calloutShared: boolean('callout_shared').notNull().default(false),
    internalKm: numeric('internal_km', { precision: 7, scale: 1 }).notNull().default('0'),
    customerKm: numeric('customer_km', { precision: 7, scale: 1 }).notNull().default('0'),
    updatedBy: uuid('updated_by')
      .notNull()
      .references(() => users.id),
    recordedAt: instant('recorded_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: rowVersion(),
  },
  (table) => [
    index('timesheet_entries_user_date_idx').on(table.userId, table.workDate),
    check(
      'timesheet_entries_hours_bounded',
      sql`${table.normalHours} between 0 and 24 and ${table.overtimeHours} between 0 and 24 and ${table.doubleHours} between 0 and 24`,
    ),
    check('timesheet_entries_callouts_bounded', sql`${table.callouts} between 0 and 10`),
    check('timesheet_entries_customer_bounded', sql`char_length(${table.customerName}) <= 200`),
    check(
      'timesheet_entries_reviewer_bounded',
      sql`${table.calloutAmountCents} between 0 and 100000000 and ${table.internalKm} between 0 and 10000 and ${table.customerKm} between 0 and 10000 and not (${table.workshop} and ${table.customerId} is not null)`,
    ),
  ],
);

/**
 * ONE TECHNICIAN'S TIMESHEET FOR ONE MONTH. TS-02, TS-03, TS-10; migration 0037.
 *
 * The one comment for the whole timesheet, and its submission to the office.
 * Once `submitted_at` is set the row is write-once — the application refuses
 * every change and the trigger `timesheet_months_write_once` refuses it again —
 * and `snapshot` is exactly what was sent.
 */
export const timesheetMonths = pgTable(
  'timesheet_months',
  {
    id: primaryId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    month: text('month').notNull(),
    comment: text('comment').notNull().default(''),
    updatedBy: uuid('updated_by')
      .notNull()
      .references(() => users.id),
    commentedAt: instant('commented_at').notNull(),
    submittedAt: instant('submitted_at'),
    submittedBy: uuid('submitted_by').references(() => users.id),
    snapshot: jsonb('snapshot'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: rowVersion(),
  },
  (table) => [
    uniqueIndex('timesheet_months_user_month_key').on(table.userId, table.month),
    check('timesheet_months_month_format', sql`${table.month} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check('timesheet_months_comment_bounded', sql`char_length(${table.comment}) <= 2000`),
    check(
      'timesheet_months_submission_whole',
      sql`(${table.submittedAt} is null and ${table.submittedBy} is null and ${table.snapshot} is null) or (${table.submittedAt} is not null and ${table.submittedBy} is not null and ${table.snapshot} is not null)`,
    ),
  ],
);

/**
 * A TECHNICIAN'S TIMESHEET FOR A CHOSEN PERIOD. TS-02, TS-03, TS-10; migration
 * 0038 (the owner's decision that the period is From/To, not a month).
 *
 * `timesheet_months` above is kept only because 0037 created it; 0038 copied
 * any rows it held into this table and nothing writes it any more.
 *
 * The trigger `timesheet_periods_guard` makes a sent period write-once and
 * refuses two sent periods of one technician that overlap.
 */
export const timesheetPeriods = pgTable(
  'timesheet_periods',
  {
    id: primaryId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    periodFrom: date('period_from').notNull(),
    periodTo: date('period_to').notNull(),
    comment: text('comment').notNull().default(''),
    updatedBy: uuid('updated_by')
      .notNull()
      .references(() => users.id),
    commentedAt: instant('commented_at').notNull(),
    submittedAt: instant('submitted_at'),
    submittedBy: uuid('submitted_by').references(() => users.id),
    snapshot: jsonb('snapshot'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: rowVersion(),
  },
  (table) => [
    uniqueIndex('timesheet_periods_user_range_key').on(table.userId, table.periodFrom, table.periodTo),
    index('timesheet_periods_user_idx').on(table.userId, table.periodFrom),
    check(
      'timesheet_periods_range_valid',
      sql`${table.periodFrom} <= ${table.periodTo} and ${table.periodTo} - ${table.periodFrom} < 92`,
    ),
    check('timesheet_periods_comment_bounded', sql`char_length(${table.comment}) <= 2000`),
    check(
      'timesheet_periods_submission_whole',
      sql`(${table.submittedAt} is null and ${table.submittedBy} is null and ${table.snapshot} is null) or (${table.submittedAt} is not null and ${table.submittedBy} is not null and ${table.snapshot} is not null)`,
    ),
  ],
);
