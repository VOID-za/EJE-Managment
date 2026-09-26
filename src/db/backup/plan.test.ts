import { describe, expect, it } from 'vitest';
import {
  backupStamp,
  BackupRefused,
  buildManifest,
  databaseNameFrom,
  planBackup,
  redactSecrets,
  redactUrl,
} from './plan';

/**
 * WHAT A BACKUP HAS TO CONTAIN, AND WHAT IT MAY NEVER PRINT. BACKUP-1.
 *
 * The end-to-end behaviour — that `pg_dump` and `tar` produce readable
 * artefacts, and that a half-backup is removed rather than reported — is proven
 * by `backup.db.test.ts` against a real database. These are the decisions made
 * before either tool runs: what is refused, where the files go, and what is kept
 * out of the output.
 */
const BASE = {
  DATABASE_URL: 'postgres://eje:s3cret@localhost:5432/eje_production',
  EJE_BACKUP_DIR: '/var/backups/eje',
} as const;

const NOW = new Date('2026-09-26T21:14:03.000Z');

describe('planning a backup', () => {
  it('refuses to run with no database', () => {
    expect(() => planBackup({ EJE_BACKUP_DIR: '/var/backups' }, NOW, '/srv/eje')).toThrow(
      BackupRefused,
    );
  });

  it('refuses to run with nowhere to write', () => {
    expect(() => planBackup({ DATABASE_URL: BASE.DATABASE_URL }, NOW, '/srv/eje')).toThrow(
      /EJE_BACKUP_DIR/u,
    );
  });

  it('names the destination after the database and the moment', () => {
    const plan = planBackup(BASE, NOW, '/srv/eje');
    expect(plan.destination).toBe('/var/backups/eje/eje-eje_production-2026-09-26T21-14-03Z');
    expect(plan.databaseName).toBe('eje_production');
  });

  it('takes the document directory from the same variable the application uses', () => {
    const plan = planBackup({ ...BASE, EJE_STORAGE_DIR: '/var/lib/eje/storage' }, NOW, '/srv/eje');
    expect(plan.storageRoot).toBe('/var/lib/eje/storage');
  });

  it('falls back to the same default the application falls back to', () => {
    // `readStorageConfiguration` resolves `.eje-storage` beside the app when
    // `EJE_STORAGE_DIR` is unset. A backup that guessed differently would
    // archive an empty directory and call it a success.
    expect(planBackup(BASE, NOW, '/srv/eje').storageRoot).toBe('/srv/eje/.eje-storage');
  });

  it('does not treat an absent directory as permission to skip the documents', () => {
    expect(planBackup(BASE, NOW, '/srv/eje').allowEmptyStorage).toBe(false);
    expect(
      planBackup({ ...BASE, EJE_BACKUP_ALLOW_EMPTY: 'yes' }, NOW, '/srv/eje').allowEmptyStorage,
    ).toBe(true);
    // Anything other than the exact word is not consent.
    expect(
      planBackup({ ...BASE, EJE_BACKUP_ALLOW_EMPTY: 'true' }, NOW, '/srv/eje').allowEmptyStorage,
    ).toBe(false);
  });
});

describe('the password never reaches the output', () => {
  it('is replaced in a connection string', () => {
    expect(redactUrl(BASE.DATABASE_URL)).not.toContain('s3cret');
    expect(redactUrl(BASE.DATABASE_URL)).toContain('eje_production');
  });

  it('says nothing at all about a string it cannot parse', () => {
    // Echoing an unparseable value could echo a credential, so it does not.
    expect(redactUrl('postgres://eje:s3cret@')).not.toContain('s3cret');
  });

  it('leaves a password-free string readable', () => {
    expect(redactUrl('postgres://localhost:5432/eje_dev')).toContain('eje_dev');
  });

  describe('a tool’s own output', () => {
    it('removes the password and KEEPS the message', () => {
      const stderr = `pg_dump: error: connection to server failed: password "s3cret" rejected`;
      const safe = redactSecrets(stderr, BASE.DATABASE_URL);

      expect(safe).not.toContain('s3cret');
      // The half that matters just as much: a failure has to stay diagnosable.
      expect(safe).toContain('connection to server failed');
    });

    it('leaves a message alone when the connection string carries no password', () => {
      const stderr = 'pg_dump: error: no such database';
      expect(redactSecrets(stderr, 'postgres://localhost/eje_dev')).toBe(stderr);
    });

    it('leaves a message alone when the connection string is unreadable', () => {
      const stderr = 'pg_dump: error: something went wrong';
      expect(redactSecrets(stderr, 'not a url')).toBe(stderr);
    });

    it('removes every occurrence, not only the first', () => {
      expect(redactSecrets('s3cret and s3cret again', BASE.DATABASE_URL)).toBe(
        '*** and *** again',
      );
    });
  });
});

describe('reading the database name', () => {
  it('takes it from the path', () => {
    expect(databaseNameFrom('postgres://h/eje_production')).toBe('eje_production');
  });

  it('answers `unknown` rather than guessing when there is no path', () => {
    expect(databaseNameFrom('postgres://localhost:5432')).toBe('unknown');
  });

  it('refuses a string that is not a URL', () => {
    expect(() => databaseNameFrom('not a url at all')).toThrow(BackupRefused);
  });
});

describe('the timestamp', () => {
  it('sorts lexically, in any locale', () => {
    const earlier = backupStamp(new Date('2026-09-26T09:00:00.000Z'));
    const later = backupStamp(new Date('2026-09-26T21:00:00.000Z'));
    expect([later, earlier].sort()).toEqual([earlier, later]);
  });

  it('carries no character a shell or a filesystem dislikes', () => {
    expect(backupStamp(NOW)).toBe('2026-09-26T21-14-03Z');
    expect(backupStamp(NOW)).not.toMatch(/[:\s/]/u);
  });
});

describe('the manifest', () => {
  const manifest = buildManifest({
    plan: planBackup(BASE, NOW, '/srv/eje'),
    now: NOW,
    storedFiles: 42,
    artefacts: [{ name: 'database.dump', bytes: 1024, sha256: 'a'.repeat(64) }],
    appCommit: 'abc1234',
  });

  it('records what was backed up, and from where', () => {
    expect(manifest.databaseName).toBe('eje_production');
    expect(manifest.storedFiles).toBe(42);
    expect(manifest.storageRoot).toBe('/srv/eje/.eje-storage');
    expect(manifest.appCommit).toBe('abc1234');
  });

  it('carries no connection string, and therefore no password', () => {
    expect(JSON.stringify(manifest)).not.toContain('s3cret');
    expect(JSON.stringify(manifest)).not.toContain('postgres://');
  });

  it('says in the file itself that nothing has been restore-tested', () => {
    // Whoever reads a manifest years from now is deciding whether to trust the
    // directory. That belongs where they are looking, not only in the docs.
    expect(manifest.notVerifiedBy).toMatch(/not encrypted/iu);
    expect(manifest.notVerifiedBy).toMatch(/BACKUP-2/u);
  });
});
