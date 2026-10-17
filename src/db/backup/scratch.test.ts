import { describe, expect, it } from 'vitest';
import {
  assertSafeToDrop,
  claimScratchDatabase,
  randomSuffix,
  scratchDatabaseName,
  withDatabase,
  type ScratchServer,
} from './scratch';
import { BackupRefused } from './plan';

/**
 * THE GUARD IN FRONT OF A DROP DATABASE, AND THE NAME IT GUARDS. BACKUP-2.
 *
 * `backup:restore-test` creates a database and destroys it. Everything else it
 * does is read-only; this is the one line that can take something away, and the
 * something it must never take away is the database being backed up. That is
 * why the guard and the claim are pure functions in their own file — so they
 * can be tested here, in `npm test`, on a machine with no PostgreSQL at all.
 *
 * The concurrency tests below are DETERMINISTIC. They do not start two
 * processes and hope the timing is interesting: they inject the suffix
 * generator, so the collision case is provoked exactly rather than waited for.
 */

const NOW = new Date('2026-10-17T09:14:03.000Z');

/** A server that records what was asked of it. No PostgreSQL involved. */
const fakeServer = (existing: readonly string[] = []) => {
  const databases = new Set(existing);
  const created: string[] = [];
  const dropped: string[] = [];
  const server: ScratchServer = {
    exists: (name) => databases.has(name),
    create: (name) => {
      databases.add(name);
      created.push(name);
    },
    drop: (name) => {
      databases.delete(name);
      dropped.push(name);
    },
  };
  return { server, created, dropped, databases };
};

describe('the scratch database name', () => {
  it('carries the prefix, the timestamp and a suffix, and is a legal identifier', () => {
    const name = scratchDatabaseName(NOW, () => 'abcd1234');
    expect(name).toBe('eje_restore_test_2026_10_17t09_14_03z_abcd1234');
    // No hyphens, no colons, nothing that would have to be quoted.
    expect(name).toMatch(/^[a-z0-9_]+$/u);
  });

  it('keeps the timestamp FIRST, so a leftover database is legible', () => {
    // Whoever finds one needs to know when it was made before anything else
    // about it. The random part is for distinctness, not for reading.
    expect(scratchDatabaseName(NOW, () => 'ffffffff')).toContain('2026_10_17t09_14_03z');
  });

  /**
   * THE DEFECT ISSUE #23 RECORDED, AND THE PROOF IT IS GONE.
   *
   * The name used to be the timestamp alone, to the second, so everything
   * generated within one second was identical. Ten thousand names at ONE fixed
   * instant is the strongest statement of the fix that does not involve the
   * clock at all: if uniqueness came from the timestamp, every one of these
   * would be the same string.
   */
  it('generates distinct names at the SAME instant — 10,000 of them', () => {
    const names = new Set(
      Array.from({ length: 10_000 }, () => scratchDatabaseName(NOW)),
    );
    expect(names.size).toBe(10_000);
  });

  it('generates a suffix that is eight hex characters', () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      expect(randomSuffix()).toMatch(/^[0-9a-f]{8}$/u);
    }
  });

  it('is still accepted by the guard, whatever the suffix', () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      expect(() => assertSafeToDrop(scratchDatabaseName(NOW), 'eje_production')).not.toThrow();
    }
  });
});

describe('what may be dropped', () => {
  it('allows a generated scratch name against a different source', () => {
    expect(() =>
      assertSafeToDrop(scratchDatabaseName(new Date()), 'eje_production'),
    ).not.toThrow();
  });

  it('REFUSES the production database, however it is reached', () => {
    expect(() => assertSafeToDrop('eje_production', 'eje_production')).toThrow(BackupRefused);
    expect(() => assertSafeToDrop('eje_production', 'eje_dev')).toThrow(/only ever/u);
    expect(() => assertSafeToDrop('eje_dev', 'eje_production')).toThrow(BackupRefused);
    expect(() => assertSafeToDrop('postgres', 'eje_production')).toThrow(BackupRefused);
  });

  it('refuses a scratch name that is also the source name', () => {
    // Contrived, and the whole point: if the generator ever collided with the
    // database being restored, the drop would destroy the original.
    const both = 'eje_restore_test_x';
    expect(() => assertSafeToDrop(both, both)).toThrow(/must never touch the database/u);
  });

  it('refuses anything that merely looks like a scratch name', () => {
    expect(() => assertSafeToDrop('eje_restore_test', 'eje_production')).toThrow(BackupRefused);
    expect(() => assertSafeToDrop('xeje_restore_test_1', 'eje_production')).toThrow(BackupRefused);
    expect(() => assertSafeToDrop('eje_restore_test_1; DROP DATABASE eje_production', 'x')).toThrow(
      BackupRefused,
    );
    expect(() => assertSafeToDrop('eje_restore_test_"quoted"', 'x')).toThrow(BackupRefused);
  });
});

describe('claiming a scratch database', () => {
  it('creates the one it named, and returns that name', () => {
    const { server, created } = fakeServer();
    const name = claimScratchDatabase(server, 'eje_production', NOW, () => 'aaaa0001');

    expect(name).toBe('eje_restore_test_2026_10_17t09_14_03z_aaaa0001');
    expect(created).toEqual([name]);
  });

  /**
   * CONCURRENT CLAIMS, DETERMINISTICALLY.
   *
   * Every claim is made against the SAME server at the SAME instant, which is
   * the condition two parallel invocations are in. Nothing here depends on
   * scheduling: if the names were still derived from the clock alone, the
   * second claim would find the first's database and be refused.
   */
  it('lets many claims at one instant each take their own database', () => {
    const { server, created } = fakeServer();
    const names = Array.from({ length: 50 }, () =>
      claimScratchDatabase(server, 'eje_production', NOW),
    );

    expect(new Set(names).size).toBe(50);
    expect(created).toHaveLength(50);
    expect(new Set(created).size).toBe(50);
  });

  it('REFUSES rather than replaces when two claims do land on one name', () => {
    /*
     * The backstop, provoked exactly. A suffix generator that always answers
     * the same thing is two invocations colliding — which randomness makes
     * vanishingly unlikely and does not make impossible. The second claim must
     * not touch the first one's database.
     */
    const { server, created } = fakeServer();
    const collide = () => 'deadbeef';

    const first = claimScratchDatabase(server, 'eje_production', NOW, collide);
    expect(() => claimScratchDatabase(server, 'eje_production', NOW, collide)).toThrow(
      /already exists/u,
    );

    // Created once, not twice: the first claim's database is untouched.
    expect(created).toEqual([first]);
  });

  it('REFUSES a database that already exists, and does not create or drop anything', () => {
    // A leftover from an interrupted run, or anything else already sitting
    // there. Replacing it would destroy whatever it holds.
    const existing = scratchDatabaseName(NOW, () => 'c0ffee11');
    const { server, created, dropped } = fakeServer([existing]);

    expect(() =>
      claimScratchDatabase(server, 'eje_production', NOW, () => 'c0ffee11'),
    ).toThrow(/Refused rather than replaced/u);

    expect(created).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it('refuses before touching the server when the name is not safe', () => {
    // The guard runs first, so an unsafe name never reaches a CREATE or a DROP.
    const { server, created, dropped } = fakeServer();
    expect(() =>
      claimScratchDatabase(server, 'eje_restore_test_2026_10_17t09_14_03z_aaaa0001', NOW, () =>
        'aaaa0001',
      ),
    ).toThrow(/must never touch the database/u);

    expect(created).toEqual([]);
    expect(dropped).toEqual([]);
  });
});

describe('pointing at another database on the same server', () => {
  it('keeps the host, the port and the credentials, and changes only the name', () => {
    const moved = withDatabase('postgres://eje:s3cret@db.internal:5433/eje_production', 'scratch');
    expect(moved).toBe('postgres://eje:s3cret@db.internal:5433/scratch');
  });
});
