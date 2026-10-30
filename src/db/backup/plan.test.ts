import { resolve } from 'node:path';
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
  // BACKUP-2: there is no unencrypted path, so a plan needs a key. A test key,
  // obviously — the real one is never in a repository.
  EJE_BACKUP_KEY: 'd'.repeat(64),
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

  it('refuses to write an unencrypted backup at all — BACKUP-2', () => {
    /*
     * Not "encrypts when a key happens to be set". There is no plaintext path:
     * a complete copy of every signed job card, written in the clear, is the
     * thing this requirement exists to stop, and a flag to permit it would be
     * used the first time somebody was in a hurry.
     */
    const { EJE_BACKUP_KEY: _omitted, ...noKey } = BASE;
    expect(() => planBackup(noKey, NOW, '/srv/eje')).toThrow(/EJE_BACKUP_KEY/u);
    expect(() => planBackup(noKey, NOW, '/srv/eje')).toThrow(/openssl rand -hex 32/u);
  });

  it('reads the key only after the plainer misconfigurations have spoken', () => {
    // Somebody who has set neither should be told about the database first;
    // the key refusal is long and would bury it.
    expect(() => planBackup({ EJE_BACKUP_DIR: '/var/backups' }, NOW, '/srv/eje')).toThrow(
      /DATABASE_URL/u,
    );
  });

  it('names the destination after the database and the moment', () => {
    const plan = planBackup(BASE, NOW, '/srv/eje');
    expect(plan.destination).toBe(resolve('/var/backups/eje/eje-eje_production-2026-09-26T21-14-03Z'));
    expect(plan.databaseName).toBe('eje_production');
  });

  it('takes the document directory from the same variable the application uses', () => {
    const plan = planBackup({ ...BASE, EJE_STORAGE_DIR: '/var/lib/eje/storage' }, NOW, '/srv/eje');
    expect(plan.storageRoot).toBe(resolve('/var/lib/eje/storage'));
  });

  it('falls back to the same default the application falls back to', () => {
    // `readStorageConfiguration` resolves `.eje-storage` beside the app when
    // `EJE_STORAGE_DIR` is unset. A backup that guessed differently would
    // archive an empty directory and call it a success.
    expect(planBackup(BASE, NOW, '/srv/eje').storageRoot).toBe(resolve('/srv/eje/.eje-storage'));
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
    artefacts: [
      {
        name: 'database.dump.enc',
        bytes: 1024,
        sha256: 'a'.repeat(64),
        plainSha256: 'b'.repeat(64),
      },
    ],
    appCommit: 'abc1234',
    keyFingerprint: '0123456789abcdef',
  });

  it('records what was backed up, and from where', () => {
    expect(manifest.databaseName).toBe('eje_production');
    expect(manifest.storedFiles).toBe(42);
    expect(manifest.storageRoot).toBe(resolve('/srv/eje/.eje-storage'));
    expect(manifest.appCommit).toBe('abc1234');
  });

  it('carries no connection string, and therefore no password', () => {
    expect(JSON.stringify(manifest)).not.toContain('s3cret');
    expect(JSON.stringify(manifest)).not.toContain('postgres://');
  });

  it('says in the file itself that nothing has been restore-tested', () => {
    // Whoever reads a manifest years from now is deciding whether to trust the
    // directory. That belongs where they are looking, not only in the docs.
    // *Amended by BACKUP-2:* it no longer says "not encrypted", because it now
    // is — and it still has to say that nobody has read these bytes back, and
    // name the command that would.
    expect(manifest.notVerifiedBy).toMatch(/NO RESTORE has been/u);
    expect(manifest.notVerifiedBy).toMatch(/backup:restore-test/u);
    expect(manifest.notVerifiedBy).not.toMatch(/not encrypted/iu);
  });

  it('records how it was encrypted, and which key it needs — BACKUP-2', () => {
    expect(manifest.encryption.algorithm).toBe('aes-256-gcm');
    // The fingerprint identifies the key. THE KEY ITSELF IS NOT IN THERE.
    expect(manifest.encryption.keyFingerprint).toBe('0123456789abcdef');
    expect(JSON.stringify(manifest)).not.toContain('d'.repeat(64));
  });

  it('keeps both checksums: the file on the shelf and the bytes inside it', () => {
    const [artefact] = manifest.artefacts;
    expect(artefact?.sha256).not.toBe(artefact?.plainSha256);
    // The encrypted one proves the artefact is intact; only the plaintext one
    // can prove a restore produced what was backed up.
    expect(artefact?.name).toMatch(/\.enc$/u);
  });
});
