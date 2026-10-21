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
 * DEFAULT `unknown`, AND IT USED TO BE `genuine`. That change is the lesson of
 * the two defects this column has already had: `JobRepository.save` and the
 * machine-photograph insert each omitted the field, the `genuine` default
 * filled it in, and the reconcile duly reported six demonstration job cards as
 * LOST CUSTOMER DOCUMENTS. A default that makes a CLAIM turns a forgotten
 * field into a false statement; a default that says "nobody recorded this"
 * turns the same omission into a visible gap.
 *
 * `simulated` would be no better as a default, and worse in one direction: it
 * would print SIMULATED across a real customer's paperwork. Every application
 * path states the value, and `provenance-writes.db.test.ts` asserts that each
 * one reaches the column.
 */
export const provenance = () => text('provenance').notNull().default('unknown');

/**
 * A byte count. `bigint` read as a JavaScript number.
 *
 * The same shape `cents()` uses, named for what it is so a size column does
 * not read as money. Node's `Number` is exact to 2^53, which is nine petabytes
 * — past anything this application will store in one file.
 */
export const bigintNumber = (name: string) => bigint(name, { mode: 'number' });
