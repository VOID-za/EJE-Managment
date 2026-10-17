import { index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, instant, primaryId } from './columns';
import { users } from './identity';
import { jobs } from './jobs';

/**
 * Captures a tablet held that the server refused, waiting for the office.
 * BD-15.
 *
 * THE ROW EXISTS BECAUSE THE WORK DOES. A technician captured three hours with
 * no signal; by the time the tablet reconnected the job had been signed, closed
 * or transferred, and the server refused the work — correctly. Without this
 * table that capture lived on exactly one tablet, and whether anything ever
 * happened to it depended on the technician remembering to mention it.
 *
 * `job_id` IS `restrict`, NOT `cascade`. A referral is a record that somebody
 * tried to put work on this job and could not, which is history: deleting the
 * job to make the referral disappear is the one thing that must not be
 * possible. (A job can only be deleted while it is Open and unassigned, so no
 * job with a referral against it is deletable anyway — this is the structural
 * half of that.)
 *
 * `(technician_id, idempotency_key)` IS UNIQUE, which is what makes referring
 * idempotent: a tablet that refers the same capture twice — a flush that ran
 * twice, a reload mid-request — gets the same referral back rather than two
 * copies of one problem on the office's screen.
 *
 * `payload` IS JSONB AND IS NOT TRUSTED. It is the body the tablet held, and it
 * is validated by the action's own schema when the office applies it, exactly
 * as it would be if it had arrived from a browser. Nothing reads it as
 * authority for anything.
 *
 * `state` AND `resolution` ARE TEXT, not enums, following `machine_approvals`:
 * a third outcome is a business decision and should not need a migration to
 * record. The TypeScript union in `src/domain/types/capture.ts` is what keeps
 * today's values honest.
 */
export const captureReferrals = pgTable(
  'capture_referrals',
  {
    id: primaryId(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'restrict' }),
    technicianId: uuid('technician_id').references(() => users.id),
    action: text('action').notNull(),
    payload: jsonb('payload').notNull(),
    summary: text('summary').notNull().default(''),
    /** The tablet's clock: when the technician actually captured the work. */
    capturedAt: instant('captured_at').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    /** The server's own refusal, kept verbatim. */
    refusalCode: text('refusal_code').notNull().default(''),
    refusalMessage: text('refusal_message').notNull().default(''),
    /** The server's clock: when the tablet handed it over. */
    referredAt: instant('referred_at').notNull(),
    state: text('state').notNull().default('open'),
    resolvedBy: uuid('resolved_by').references(() => users.id),
    resolvedAt: instant('resolved_at'),
    resolution: text('resolution'),
    resolutionNote: text('resolution_note').notNull().default(''),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('capture_referrals_capture_key').on(table.technicianId, table.idempotencyKey),
    index('capture_referrals_state_idx').on(table.state, table.referredAt),
    index('capture_referrals_job_idx').on(table.jobId),
    index('capture_referrals_technician_idx').on(table.technicianId, table.referredAt),
  ],
);
