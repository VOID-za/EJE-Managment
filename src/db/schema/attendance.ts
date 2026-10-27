import { sql } from 'drizzle-orm';
import { check, date, index, integer, numeric, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
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
  ],
);
