import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, instant, primaryId } from './columns';
import { users } from './identity';

/**
 * Replayed requests.
 *
 * A technician on a tablet at the back of a workshop taps "Accept job", the
 * request goes out, the signal drops, and the tablet retries. Without this the
 * job is accepted twice — or worse, a signature is captured twice and two
 * pricing snapshots are frozen.
 *
 * The client sends an `Idempotency-Key`. The FIRST request to present it does
 * the work and stores what it answered; every later request presenting the same
 * key is handed that answer back without the business operation running again.
 *
 * SCOPED TO THE USER AND THE OPERATION, not to the key alone: a key is a value
 * a client chose, and one client's key must never be able to collide with
 * another's, nor let "accept" replay as "delete".
 *
 * `request_hash` is what catches a client reusing a key for a DIFFERENT body.
 * That is a client bug, and answering it with the first request's result would
 * silently drop the second change; it is refused instead.
 */
export const apiIdempotency = pgTable(
  'api_idempotency',
  {
    id: primaryId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The application-level operation, e.g. `jobs.accept`. */
    operation: text('operation').notNull(),
    /** The client's key. Opaque to the server. */
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    /** Null while the first request is still in flight. */
    responseBody: jsonb('response_body'),
    completedAt: instant('completed_at'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('api_idempotency_scope_key').on(
      table.userId,
      table.operation,
      table.idempotencyKey,
    ),
    // Swept by age, so the table does not grow for ever.
    index('api_idempotency_created_at_idx').on(table.createdAt),
  ],
);

/**
 * How long a key is honoured.
 *
 * Long enough to cover a retry that a person would actually make, short enough
 * that the table stays small. Sweeping is the application's job — see
 * `src/server/api/idempotency.ts` — because a cron job is a thing to run and
 * this is a thing to do on the way past.
 */
export const IDEMPOTENCY_RETENTION = sql`interval '24 hours'`;
