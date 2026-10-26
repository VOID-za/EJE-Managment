import { sql } from 'drizzle-orm';
import { check, date, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, instant, primaryId, rowVersion, updatedAt } from './columns';
import { users } from './identity';

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
