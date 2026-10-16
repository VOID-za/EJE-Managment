import { describe, expect, it } from 'vitest';
import { assertSafeToDrop, scratchDatabaseName, withDatabase } from './scratch';
import { BackupRefused } from './plan';

/**
 * THE GUARD IN FRONT OF A DROP DATABASE. BACKUP-2.
 *
 * `backup:restore-test` creates a database and destroys it. Everything else it
 * does is read-only; this is the one line that can take something away, and the
 * something it must never take away is the database being backed up. That is
 * why the guard is a pure function in its own file — so it can be tested here,
 * in `npm test`, on a machine with no PostgreSQL at all.
 */

describe('the scratch database name', () => {
  it('is generated from the clock and carries the prefix', () => {
    const name = scratchDatabaseName(new Date('2026-09-26T21:14:03.000Z'));
    expect(name).toBe('eje_restore_test_2026_09_26t21_14_03z');
    // A legal identifier: no hyphens, no colons, nothing to quote.
    expect(name).toMatch(/^[a-z0-9_]+$/u);
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

describe('pointing at another database on the same server', () => {
  it('keeps the host, the port and the credentials, and changes only the name', () => {
    const moved = withDatabase('postgres://eje:s3cret@db.internal:5433/eje_production', 'scratch');
    expect(moved).toBe('postgres://eje:s3cret@db.internal:5433/scratch');
  });
});
