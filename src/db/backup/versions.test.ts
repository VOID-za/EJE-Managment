import { describe, expect, it } from 'vitest';
import {
  compareMajors,
  looksLikeVersionSkew,
  majorFromServerVersion,
  majorFromToolVersion,
  skewDiagnosis,
  skewNote,
  skewRefusal,
} from './versions';

/**
 * A BACKUP THAT CANNOT BE RESTORED ONTO THE MACHINE IT CAME FROM.
 * BACKUP-1, BACKUP-2.
 *
 * Found by CI: the runner started shipping PostgreSQL 17 client tools against
 * the 16 that production runs, and every restore died with "unrecognized
 * configuration parameter transaction_timeout". The same thing happens on a VPS
 * the day `apt upgrade` pulls in a newer client beside an unchanged server —
 * and until then every backup reports success.
 */
describe('reading the versions', () => {
  it('reads pg_dump’s own banner, in the shapes it actually prints', () => {
    expect(majorFromToolVersion('pg_dump (PostgreSQL) 17.2 (Debian 17.2-1.pgdg120+1)')).toBe(17);
    expect(majorFromToolVersion('pg_dump (PostgreSQL) 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)')).toBe(
      16,
    );
    expect(majorFromToolVersion('pg_dump (PostgreSQL) 18beta1')).toBe(18);
  });

  it('reads both shapes a server reports', () => {
    // `server_version_num` is what a query returns; `server_version` is what an
    // operator pastes out of psql.
    expect(majorFromServerVersion('160015')).toBe(16);
    expect(majorFromServerVersion('170002')).toBe(17);
    expect(majorFromServerVersion('16.15 (Debian 16.15-1.pgdg13+2)')).toBe(16);
  });

  it('answers null rather than a wrong number', () => {
    for (const text of ['', 'pg_dump: command not found', 'unknown']) {
      expect(majorFromToolVersion(text), text).toBeNull();
    }
  });
});

describe('what to do about a mismatch', () => {
  it('REFUSES a client newer than its server, and says why the dump is useless', () => {
    const refusal = skewRefusal(compareMajors(17, 16), 17, 16);

    expect(refusal).toMatch(/CANNOT BE RESTORED onto this server/u);
    // The remedy has to be the package name, because that is the action.
    expect(refusal).toMatch(/postgresql-client-16/u);
    // And the override exists, because a restore target may legitimately be a
    // newer server — but it must be written down.
    expect(refusal).toMatch(/EJE_BACKUP_ALLOW_VERSION_SKEW=yes/u);
  });

  it('REFUSES a client older than its server, for a different reason', () => {
    // Not "it cannot be restored" — it may not have dumped everything.
    const refusal = skewRefusal(compareMajors(15, 16), 15, 16);
    expect(refusal).toMatch(/can omit objects/u);
    expect(refusal).toMatch(/missing a table is worse than no backup/u);
  });

  it('allows a match', () => {
    expect(compareMajors(16, 16)).toBe('match');
    expect(skewRefusal('match', 16, 16)).toBeNull();
  });

  /**
   * AN UNREADABLE VERSION IS NOT A REFUSAL.
   *
   * Refusing every backup on a machine whose `pg_dump --version` cannot be
   * parsed would turn a cosmetic problem into no backups at all. It is
   * reported, loudly, and the backup is taken.
   */
  it('does not refuse what it could not read, and says so instead', () => {
    expect(compareMajors(null, 16)).toBe('unknown');
    expect(skewRefusal('unknown', null, 16)).toBeNull();
    expect(skewNote('unknown', null, 16)).toMatch(/could not be read/u);
    expect(skewNote('match', 16, 16)).toBeNull();
  });
});

describe('the confusing error this produces at restore time', () => {
  const stderr =
    'pg_restore: error: could not execute query: ERROR:  unrecognized configuration ' +
    'parameter "transaction_timeout"';

  it('is recognised for what it is', () => {
    expect(looksLikeVersionSkew(stderr)).toBe(true);
    expect(looksLikeVersionSkew('pg_restore: error: out of memory')).toBe(false);
  });

  it('is explained, because the message reads like a server setting and is not', () => {
    const diagnosis = skewDiagnosis(stderr);
    expect(diagnosis).toMatch(/VERSION MISMATCH, not a server setting/u);
    expect(diagnosis).toMatch(/NEWER\s+pg_dump/u);
    expect(skewDiagnosis('pg_restore: error: out of memory')).toBe('');
  });
});
