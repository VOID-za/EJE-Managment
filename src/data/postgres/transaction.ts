import type { Database, DatabaseExecutor } from '@/db/client';

/**
 * Transaction boundaries.
 *
 * Almost every business operation writes more than one table: accepting a job
 * changes the job AND opens a participation record AND appends an audit event;
 * capturing a signature writes the signature AND freezes a pricing snapshot AND
 * its lines. None of those may be half-done. A job with a signature and no
 * snapshot would re-price itself from today's rates the next time anything
 * read it, which is the exact failure the snapshot exists to prevent.
 *
 * The operations themselves do not change. They take an `OperationContext`
 * carrying repositories; in production the handler opens a transaction and
 * builds a context whose repositories are bound to it, so `addLabour` still
 * simply calls `context.repos.jobs.save(...)` and knows nothing about SQL.
 *
 * THE API LAYER IS NOT BUILT IN THIS PHASE. This is the capability it will use.
 */

/**
 * Runs `work` inside one transaction, committing on return and rolling back on
 * any throw.
 *
 * The executor handed to `work` is the transaction, and every repository built
 * from it writes through the same connection — which is what makes the
 * all-or-nothing guarantee real rather than hoped for.
 */
export const withTransaction = async <T>(
  db: Database,
  work: (tx: DatabaseExecutor) => Promise<T>,
): Promise<T> => db.transaction(async (tx) => work(tx));

/**
 * Raised when a write lost a race.
 *
 * Every mutable aggregate carries a `version`, and an update says
 * `where version = $expected`. Zero rows changed means somebody else wrote
 * first. The caller must re-read and decide — never retry blindly, because the
 * change it wanted to make may no longer be legal against the newer state.
 */
export class ConcurrencyError extends Error {
  constructor(
    readonly entity: string,
    readonly id: string,
    readonly expectedVersion: number,
  ) {
    super(
      `${entity} ${id} was changed by someone else while you were working on it. Reload it and try again.`,
    );
    this.name = 'ConcurrencyError';
  }
}

/**
 * Raised when a write would have altered what a customer signed for. AUD-10.
 *
 * The evidence on a signed job card — labour, travel, parts, notes, media — is
 * final at every layer: the operations refuse to edit it (`assertEditable`),
 * the repository declines to rewrite it, and
 * `0007_signed_job_immutability.sql` refuses the UPDATE or DELETE outright.
 * This is the middle one, and it exists so the middle layer FAILS LOUDLY rather
 * than quietly dropping a change it has decided not to make.
 *
 * Reaching it means a caller handed the repository a signed job whose job card
 * differs from the stored one. That is a programming error, not something a
 * person can do — every route into those collections is already refused above —
 * so it names the collection and says what it will not do, for whoever is
 * reading the log.
 */
export class SignedJobCardAltered extends Error {
  constructor(
    readonly jobNumber: string,
    /** The collections that differ, e.g. `['labour', 'parts']`. */
    readonly collections: readonly string[],
  ) {
    super(
      `${jobNumber} has been signed by the customer, so its ${collections.join(' and ')} ` +
        'cannot be rewritten. The signed job card is final.',
    );
    this.name = 'SignedJobCardAltered';
  }
}
