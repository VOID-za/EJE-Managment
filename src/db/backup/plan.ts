import { resolve } from 'node:path';

/**
 * WHAT A BACKUP OF THIS SYSTEM HAS TO CONTAIN. MASTER SCOPE BACKUP-1.
 *
 * "Database **and files** backed up" — and the second half is the half that was
 * missing. `docs/vps-deployment.md` documented one `pg_dump` line, which is a
 * backup of the INDEX: `job_media` and `final_documents` hold a `storage_key`
 * and nothing else, because the bytes live on a filesystem under
 * `EJE_STORAGE_DIR`. Restoring the dump on its own gives a database full of
 * rows pointing at signed job cards that are gone.
 *
 * That matters more here than in most systems. A customer-signed job card is
 * legally final (CR-01) and its original PDF may never change (IMMUT-6); the
 * only copy of it is a file on that disk. The database can be rebuilt from
 * migrations and re-seeded. The signed documents cannot be rebuilt from
 * anything.
 *
 * SO THE TWO ARE ONE ARTEFACT. They are written into one timestamped directory,
 * their checksums are recorded together, and if either half cannot be produced
 * the whole thing fails and is removed. A database-only backup that LOOKED like
 * a backup would be worse than no backup at all, because somebody would rely on
 * it.
 *
 * WHAT THIS IS NOT. BACKUP-2 — encrypted, integrity-verified, restore-tested —
 * is a separate requirement and remains NOT IMPLEMENTED. The checksums written
 * here are what a later restore test would check against; they are not that
 * test, and nothing in this file encrypts anything or claims to.
 */
export class BackupRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupRefused';
  }
}

export interface BackupPlan {
  /** The connection string, as given. Never logged — see `redactUrl`. */
  readonly databaseUrl: string;
  /** The database's own name, for the manifest and the file name. */
  readonly databaseName: string;
  /** Absolute path to the directory holding the documents. */
  readonly storageRoot: string;
  /** Absolute path of the directory this run will create. */
  readonly destination: string;
  /** Set when the storage directory is allowed to be absent or empty. */
  readonly allowEmptyStorage: boolean;
}

/** The default the application itself uses when `EJE_STORAGE_DIR` is unset. */
const DEFAULT_STORAGE_DIRECTORY = '.eje-storage';

/**
 * A timestamp that sorts, in every locale, with no punctuation a shell dislikes.
 *
 * `2026-09-26T21-14-03Z`. Deliberately not a locale format and deliberately not
 * seconds-since-epoch: the first sorts wrongly and the second cannot be read by
 * the person deciding which backup to restore.
 */
export const backupStamp = (now: Date): string =>
  `${now.toISOString().slice(0, 19).replace(/:/gu, '-')}Z`;

/**
 * The database name out of a connection string.
 *
 * Wanted for the manifest and the directory name, so a person looking at a
 * shelf of backups can see which database each one is of.
 */
export const databaseNameFrom = (url: string): string => {
  try {
    const path = new URL(url).pathname.replace(/^\//u, '');
    return path.length === 0 ? 'unknown' : decodeURIComponent(path);
  } catch {
    throw new BackupRefused('DATABASE_URL is not a URL this can read.');
  }
};

/**
 * The connection string with the password taken out.
 *
 * Everything this command prints goes through here. A backup script's output is
 * exactly what ends up in a cron mail, a CI log or a terminal somebody
 * screenshots, and the one thing it must never contain is the database
 * password.
 */
export const redactUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    if (parsed.password.length > 0) parsed.password = '***';
    return parsed.toString();
  } catch {
    // Unparseable: say nothing about it rather than echo something that might
    // be a credential.
    return '[unreadable connection string]';
  }
};

/**
 * A tool's own output, with the password taken out of it. BACKUP-1, rule 27.
 *
 * NOT `redactUrl`. That parses a whole string AS a URL, which is right for
 * printing a connection string and wrong for everything else: `pg_dump`'s stderr
 * is an English sentence, `new URL` throws on it, and the operator would be
 * handed "[unreadable connection string]" instead of the reason their backup
 * failed. That was the first version of this file, and it made a failure
 * undiagnosable.
 *
 * So this keeps the message and removes the secret from inside it, the way
 * `CloudApiWhatsAppService.redact` and `GraphEmailService.redact` already do. A
 * cron mail is exactly where a password must not appear and exactly where the
 * diagnosis has to.
 */
export const redactSecrets = (text: string, url: string): string => {
  let password = '';
  try {
    password = new URL(url).password;
  } catch {
    password = '';
  }
  if (password.length === 0) return text;
  return text.split(password).join('***');
};

export const planBackup = (
  env: Readonly<Record<string, string | undefined>>,
  now: Date,
  cwd: string,
): BackupPlan => {
  const databaseUrl = (env.DATABASE_URL ?? '').trim();
  if (databaseUrl.length === 0) {
    throw new BackupRefused(
      'DATABASE_URL is not set, so there is no database to back up. See docs/vps-deployment.md.',
    );
  }

  const into = (env.EJE_BACKUP_DIR ?? '').trim();
  if (into.length === 0) {
    throw new BackupRefused(
      'EJE_BACKUP_DIR is not set. Name the directory to write the backup into — ' +
        'it must be on a volume that is not the one being backed up.',
    );
  }

  const configuredStorage = (env.EJE_STORAGE_DIR ?? '').trim();
  const storageRoot =
    configuredStorage.length > 0
      ? resolve(configuredStorage)
      : resolve(cwd, DEFAULT_STORAGE_DIRECTORY);

  const databaseName = databaseNameFrom(databaseUrl);

  return {
    databaseUrl,
    databaseName,
    storageRoot,
    destination: resolve(into, `eje-${databaseName}-${backupStamp(now)}`),
    allowEmptyStorage: (env.EJE_BACKUP_ALLOW_EMPTY ?? '').trim() === 'yes',
  };
};

export interface ArtefactRecord {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface BackupManifest {
  readonly takenAt: string;
  readonly databaseName: string;
  readonly storageRoot: string;
  /** How many files were archived. Zero is legitimate only on a fresh install. */
  readonly storedFiles: number;
  readonly artefacts: readonly ArtefactRecord[];
  /** What produced it, so a restore can be matched to a build. */
  readonly appCommit: string;
  /**
   * Said out loud in the manifest itself, not only in the documentation.
   *
   * Somebody reading a manifest three years from now is deciding whether they
   * can trust what is in the directory. "This has never been restore-tested"
   * belongs where they are looking.
   */
  readonly notVerifiedBy: string;
}

export const buildManifest = (input: {
  readonly plan: BackupPlan;
  readonly now: Date;
  readonly storedFiles: number;
  readonly artefacts: readonly ArtefactRecord[];
  readonly appCommit: string;
}): BackupManifest => ({
  takenAt: input.now.toISOString(),
  databaseName: input.plan.databaseName,
  storageRoot: input.plan.storageRoot,
  storedFiles: input.storedFiles,
  artefacts: input.artefacts,
  appCommit: input.appCommit,
  notVerifiedBy:
    'No restore has been performed against this backup, and it is not encrypted. ' +
    'BACKUP-2 in docs/SCOPE.md owns both and is NOT IMPLEMENTED.',
});
