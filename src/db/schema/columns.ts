import { sql } from 'drizzle-orm';
import { bigint, integer, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Column helpers, so a convention is written once instead of copied.
 *
 * Three conventions matter enough to be enforced here rather than remembered:
 *
 *  - MONEY IS INTEGER CENTS. `bigint` with `mode: 'number'`, never `numeric`
 *    and never a float. The domain already models money as `Cents`, and a job
 *    card the customer signed has to reproduce its arithmetic exactly.
 *  - TIMESTAMPS ARE TIMEZONE-AWARE. `timestamptz` everywhere. Presentation
 *    reads them in EJE's business zone through `src/lib/business-time.ts`; the
 *    STORED value is always the instant, never a wall clock.
 *  - VERSION IS FOR OPTIMISTIC CONCURRENCY. Every mutable aggregate root has
 *    one, and an update carries `where version = $expected`. A zero-row result
 *    is a conflict, not a silent no-op.
 */

/** Primary key: a UUID the application generates, so a client can reference a row it has not sent yet. */
export const primaryId = () => uuid('id').primaryKey();

/** Money, in South African cents. Never a float, never a display string. */
export const cents = (name: string) => bigint(name, { mode: 'number' });

/** An instant. Always `timestamptz`; the zone belongs to presentation. */
export const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });

export const createdAt = () =>
  instant('created_at')
    .notNull()
    .default(sql`now()`);

export const updatedAt = () =>
  instant('updated_at')
    .notNull()
    .default(sql`now()`);

/**
 * Optimistic concurrency token.
 *
 * Bumped by the repository on every write, never by a trigger — a trigger would
 * bump it for the writer too and make the check meaningless.
 */
export const rowVersion = () => integer('version').notNull().default(1);

/**
 * Withdrawn from the live register, still resolvable for ever.
 *
 * Used by sites, contacts and machines. NOT used by jobs: DECISION 6 makes job
 * deletion permanent, so there is no `deleted_at` on `jobs` at all.
 * `src/application/removal.ts` states the rule this implements — "Nothing that
 * a job refers to is ever deleted."
 */
export const archivedAt = () => instant('archived_at');

/**
 * WHETHER THE ROW IS AN EJE RECORD OR DEMONSTRATION DATA. October mandate §1.
 *
 * `text` with a CHECK rather than an enum, for the reason `delivery_attempts
 * .failure_kind` is text: the vocabulary belongs to the domain
 * (`Provenance`), and a value this application does not know must read as
 * unrecognised rather than need a migration.
 *
 * DEFAULT `genuine`, and that direction is deliberate. Every row that exists
 * now was written by the application or by the seed; the seed is being changed
 * to say `simulated` for its own rows, and nothing else may. A default of
 * `simulated` would silently label real customer documents as fixtures, which
 * is the one mistake here that could lose a real record.
 */
export const provenance = () =>
  text('provenance').notNull().default('genuine');
