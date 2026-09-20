import { ConcurrencyError } from './transaction';

/**
 * What version of each record this unit of work last read.
 *
 * Optimistic concurrency needs the version the CALLER reasoned about, and the
 * domain types deliberately carry none — a row version is a persistence
 * concern, not a business fact, and putting it on `Job` or `Customer` would
 * push it into every screen and every test fixture.
 *
 * So the repository remembers. A repository instance is one unit of work — one
 * request, one transaction — and an operation always loads a record before it
 * writes one, so what this instance read IS what the caller decided against.
 *
 * Re-reading the version inside `save` instead would defeat the whole thing: it
 * would always match, and the second of two concurrent writers would silently
 * overwrite the first. That was a real defect in the first draft of the job
 * repository, caught by its own test.
 */
export class VersionLedger {
  private readonly seen = new Map<string, number>();

  remember(id: string, version: number): void {
    this.seen.set(id, version);
  }

  rememberAll(rows: readonly { readonly id: string; readonly version: number }[]): void {
    for (const row of rows) this.seen.set(row.id, row.version);
  }

  /**
   * The version an update must find, given what is stored now.
   *
   * A caller that never read the record through this repository is writing
   * blind and is given the stored version, because refusing it would break
   * legitimate first-write paths. A caller that DID read it is held to what it
   * read, which is what makes the second of two concurrent writers lose.
   */
  expected(id: string, current: number): number {
    return this.seen.get(id) ?? current;
  }

  forget(id: string): void {
    this.seen.delete(id);
  }
}

/**
 * Turns "no rows were updated" into the error the caller has to handle.
 *
 * Every optimistic update says `where version = $expected`; zero rows changed
 * means somebody else wrote first. The caller must re-read and decide — never
 * retry blindly, because the change it wanted may no longer be legal against
 * the newer state.
 */
export const requireWritten = <T extends { version: number }>(
  updated: readonly T[],
  entity: string,
  id: string,
  expected: number,
): T => {
  const written = updated[0];
  if (written === undefined) throw new ConcurrencyError(entity, id, expected);
  return written;
};
