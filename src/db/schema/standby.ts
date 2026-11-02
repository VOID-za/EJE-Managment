import { sql } from 'drizzle-orm';
import { boolean, check, date, index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, instant, primaryId, rowVersion, updatedAt } from './columns';
import { users } from './identity';

/**
 * THE STANDBY CALENDAR. STANDBY-1…8, migration 0045.
 *
 * Four tables, and nothing in them is ever deleted (the database refuses it):
 *
 *   standby_eligibility    — who may stand in which place. The office keeps it;
 *                            the role cannot say who is an apprentice.
 *   standby_weeks          — one row per week (its Monday), draft or published.
 *   standby_assignments    — the four places of a week; an empty place has a
 *                            NULL user. Nobody holds two places in one week.
 *   standby_swap_requests  — a request to exchange one place between two people
 *                            in two weeks, and the office's decision on it.
 *
 * The audit trail of every change is `audit_events`, as for everything else.
 */
export const standbyEligibility = pgTable(
  'standby_eligibility',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'restrict' }),
    mayMain: boolean('may_main').notNull().default(false),
    mayHelper: boolean('may_helper').notNull().default(false),
    mayApprentice: boolean('may_apprentice').notNull().default(false),
    updatedBy: uuid('updated_by').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: rowVersion(),
  },
  (table) => [
    check(
      'standby_eligibility_apprentice_apart',
      sql`not (${table.mayApprentice} and (${table.mayMain} or ${table.mayHelper}))`,
    ),
  ],
);

export const standbyWeeks = pgTable(
  'standby_weeks',
  {
    id: primaryId(),
    weekStart: date('week_start').notNull(),
    status: text('status').notNull().default('draft'),
    publishedBy: uuid('published_by').references(() => users.id),
    publishedAt: instant('published_at'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: rowVersion(),
  },
  (table) => [
    uniqueIndex('standby_weeks_week_start_key').on(table.weekStart),
    check('standby_weeks_starts_monday', sql`extract(isodow from ${table.weekStart}) = 1`),
    check('standby_weeks_status_known', sql`${table.status} in ('draft', 'published')`),
    check(
      'standby_weeks_publication_whole',
      sql`${table.status} = 'draft' or (${table.publishedBy} is not null and ${table.publishedAt} is not null)`,
    ),
  ],
);

export const standbyAssignments = pgTable(
  'standby_assignments',
  {
    id: primaryId(),
    weekId: uuid('week_id')
      .notNull()
      .references(() => standbyWeeks.id, { onDelete: 'restrict' }),
    position: text('position').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'restrict' }),
    assignedBy: uuid('assigned_by').references(() => users.id),
    assignedAt: instant('assigned_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: rowVersion(),
  },
  (table) => [
    uniqueIndex('standby_assignments_week_position_key').on(table.weekId, table.position),
    uniqueIndex('standby_assignments_week_user_key').on(table.weekId, table.userId),
    index('standby_assignments_user_idx').on(table.userId),
    check(
      'standby_assignments_position_known',
      sql`${table.position} in ('main', 'helper', 'apprentice_1', 'apprentice_2')`,
    ),
  ],
);

export const standbySwapRequests = pgTable(
  'standby_swap_requests',
  {
    id: primaryId(),
    kind: text('kind').notNull(),
    requesterId: uuid('requester_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    requesterWeekId: uuid('requester_week_id')
      .notNull()
      .references(() => standbyWeeks.id, { onDelete: 'restrict' }),
    requesterPosition: text('requester_position').notNull(),
    counterpartId: uuid('counterpart_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    counterpartWeekId: uuid('counterpart_week_id')
      .notNull()
      .references(() => standbyWeeks.id, { onDelete: 'restrict' }),
    counterpartPosition: text('counterpart_position').notNull(),
    reason: text('reason').notNull().default(''),
    status: text('status').notNull().default('pending'),
    requestedAt: instant('requested_at').notNull(),
    decidedBy: uuid('decided_by').references(() => users.id),
    decidedAt: instant('decided_at'),
    decisionNote: text('decision_note').notNull().default(''),
    cancelledAt: instant('cancelled_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: rowVersion(),
  },
  (table) => [
    // A place is offered in at most one pending request at a time, on each side.
    uniqueIndex('standby_swap_requests_requester_slot_pending_key')
      .on(table.requesterWeekId, table.requesterPosition)
      .where(sql`${table.status} = 'pending'`),
    uniqueIndex('standby_swap_requests_counterpart_slot_pending_key')
      .on(table.counterpartWeekId, table.counterpartPosition)
      .where(sql`${table.status} = 'pending'`),
    index('standby_swap_requests_requester_idx').on(table.requesterId),
    index('standby_swap_requests_counterpart_idx').on(table.counterpartId),
    index('standby_swap_requests_status_idx').on(table.status),
    check('standby_swap_requests_kind_known', sql`${table.kind} in ('main', 'apprentice')`),
    check(
      'standby_swap_requests_status_known',
      sql`${table.status} in ('pending', 'approved', 'rejected', 'cancelled')`,
    ),
    check(
      'standby_swap_requests_places_match_kind',
      sql`(${table.kind} = 'main' and ${table.requesterPosition} = 'main' and ${table.counterpartPosition} = 'main') or (${table.kind} = 'apprentice' and ${table.requesterPosition} in ('apprentice_1', 'apprentice_2') and ${table.counterpartPosition} in ('apprentice_1', 'apprentice_2'))`,
    ),
    check('standby_swap_requests_two_people', sql`${table.requesterId} <> ${table.counterpartId}`),
    check('standby_swap_requests_two_weeks', sql`${table.requesterWeekId} <> ${table.counterpartWeekId}`),
    check('standby_swap_requests_reason_bounded', sql`char_length(${table.reason}) <= 1000`),
    check('standby_swap_requests_note_bounded', sql`char_length(${table.decisionNote}) <= 2000`),
    check(
      'standby_swap_requests_outcome_whole',
      sql`(${table.status} = 'pending' and ${table.decidedBy} is null and ${table.decidedAt} is null and ${table.cancelledAt} is null) or (${table.status} in ('approved', 'rejected') and ${table.decidedBy} is not null and ${table.decidedAt} is not null and ${table.cancelledAt} is null) or (${table.status} = 'cancelled' and ${table.decidedBy} is null and ${table.cancelledAt} is not null)`,
    ),
    check(
      'standby_swap_requests_decided_by_another',
      sql`${table.decidedBy} is null or ${table.decidedBy} <> ${table.requesterId}`,
    ),
  ],
);

/**
 * DAY SWAPS. STANDBY-DAY-1 (2 November 2026), migration 0047.
 *
 *   standby_day_swaps      — a request to exchange chosen DAYS: who asked, who
 *                            was asked, the date pairs (fixed once written),
 *                            the person asked's answer and the Office's.
 *   standby_day_overrides  — one day's place held by somebody other than the
 *                            week's assignee; written ONLY by an approved day
 *                            swap. Never deleted.
 */
export const standbyDaySwaps = pgTable(
  'standby_day_swaps',
  {
    id: primaryId(),
    kind: text('kind').notNull(),
    requesterId: uuid('requester_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** [{ requesterDate, requesterPosition, recipientDate, recipientPosition }] — at least one. */
    pairs: jsonb('pairs').$type<{ requesterDate: string; requesterPosition: string; recipientDate: string; recipientPosition: string }[]>().notNull(),
    reason: text('reason').notNull().default(''),
    status: text('status').notNull().default('awaiting_recipient'),
    requestedAt: instant('requested_at').notNull(),
    recipientDecidedAt: instant('recipient_decided_at'),
    recipientNote: text('recipient_note').notNull().default(''),
    officeDecidedBy: uuid('office_decided_by').references(() => users.id),
    officeDecidedAt: instant('office_decided_at'),
    officeNote: text('office_note').notNull().default(''),
    withdrawnAt: instant('withdrawn_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: rowVersion(),
  },
  (table) => [
    index('standby_day_swaps_requester_idx').on(table.requesterId),
    index('standby_day_swaps_recipient_idx').on(table.recipientId),
    index('standby_day_swaps_status_idx').on(table.status),
    check('standby_day_swaps_kind_known', sql`${table.kind} in ('main', 'apprentice')`),
    check(
      'standby_day_swaps_status_known',
      sql`${table.status} in ('awaiting_recipient', 'awaiting_office', 'approved', 'denied', 'rejected', 'withdrawn')`,
    ),
    check('standby_day_swaps_two_people', sql`${table.requesterId} <> ${table.recipientId}`),
    check('standby_day_swaps_has_pairs', sql`jsonb_typeof(${table.pairs}) = 'array' and jsonb_array_length(${table.pairs}) between 1 and 14`),
    check(
      'standby_day_swaps_office_is_another',
      sql`${table.officeDecidedBy} is null or (${table.officeDecidedBy} <> ${table.requesterId} and ${table.officeDecidedBy} <> ${table.recipientId})`,
    ),
  ],
);

export const standbyDayOverrides = pgTable(
  'standby_day_overrides',
  {
    id: primaryId(),
    date: date('date').notNull(),
    position: text('position').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    swapId: uuid('swap_id')
      .notNull()
      .references(() => standbyDaySwaps.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: rowVersion(),
  },
  (table) => [
    uniqueIndex('standby_day_overrides_date_position_key').on(table.date, table.position),
    index('standby_day_overrides_user_idx').on(table.userId),
    check(
      'standby_day_overrides_position_known',
      sql`${table.position} in ('main', 'helper', 'apprentice_1', 'apprentice_2')`,
    ),
  ],
);
