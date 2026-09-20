import { sql } from 'drizzle-orm';
import { boolean, check, date, index, pgTable, text, time, uuid } from 'drizzle-orm/pg-core';
import { createdAt, instant, primaryId, rowVersion, updatedAt } from './columns';
import { availabilityStatus, availabilityType } from './enums';
import { users } from './identity';

/**
 * When a technician is NOT available.
 *
 * Records of unavailability rather than a presence calendar: a technician is
 * available unless something says otherwise. That keeps the table small and
 * matches how the office actually administers it.
 *
 * A record is AUTHORITATIVE and only the office creates one. A technician
 * telling the office they have an appointment is a chat MESSAGE, not an
 * availability record — the office decides what goes on the calendar. The two
 * are separate tables for exactly that reason, and a message that led to a
 * record links to it rather than becoming one.
 *
 * A cancelled record stays on file; it simply stops blocking.
 */
export const availability = pgTable(
  'availability',
  {
    id: primaryId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    type: availabilityType('type').notNull(),
    status: availabilityStatus('status').notNull().default('active'),

    /** Inclusive at both ends, so a single day has start = end. */
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    allDay: boolean('all_day').notNull().default(true),
    /** Wall-clock times, meaningful only when `all_day` is false. */
    startTime: time('start_time'),
    endTime: time('end_time'),

    description: text('description').notNull().default(''),

    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
    cancelledBy: uuid('cancelled_by').references(() => users.id),
    cancelledAt: instant('cancelled_at'),
    updatedAt: updatedAt(),
    version: rowVersion(),
  },
  (table) => [
    // The conflict check asks: does this person have anything active in this window?
    index('availability_user_window_idx')
      .on(table.userId, table.startDate, table.endDate)
      .where(sql`${table.status} = 'active'`),
    index('availability_window_idx').on(table.startDate, table.endDate),
    check('availability_range_ordered', sql`${table.endDate} >= ${table.startDate}`),
    check(
      'availability_timed_needs_times',
      sql`${table.allDay} or (${table.startTime} is not null and ${table.endTime} is not null)`,
    ),
    check(
      'availability_cancelled_has_stamp',
      sql`${table.status} <> 'cancelled' or ${table.cancelledAt} is not null`,
    ),
  ],
);
