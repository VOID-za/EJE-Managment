import type { IdGenerator } from '../ports';

/**
 * Identifiers for production.
 *
 * A UUID, because every primary key in the PostgreSQL schema is `uuid` and the
 * application supplies the value — which is what lets an operation reference a
 * record it has not written yet, inside a transaction, without a round trip.
 *
 * The prefix is IGNORED, deliberately. `SequentialIdGenerator` builds readable
 * ids like `lab-m2k9-3` for the demonstration, and the call sites still pass a
 * prefix so the two are interchangeable; a prefix inside a uuid column would
 * simply fail to store, which is better than a key that half means something.
 */
export class UuidGenerator implements IdGenerator {
  next(_prefix: string): string {
    return crypto.randomUUID();
  }
}
