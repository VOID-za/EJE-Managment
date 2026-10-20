import { backupStamp } from './plan';

/**
 * WHICH OLD BACKUPS MAY BE REMOVED, AND WHICH MAY NEVER BE. BACKUP-2.
 *
 * A scheduled backup fills a disk, and a full disk is how backups stop
 * happening — so retention is part of making them repeatable rather than a
 * tidiness feature. It is also the most dangerous code in this directory,
 * because it deletes the thing everything else exists to protect. Hence:
 *
 *   - IT IS OFF UNLESS A NUMBER IS SET. No default retention, no "keep 7"
 *     chosen by a library. An operator who has not said how many to keep gets
 *     every backup kept and a disk they can see filling.
 *   - IT ONLY EVER CONSIDERS DIRECTORIES THIS SYSTEM WROTE, matched by the
 *     exact name shape `eje-<database>-<stamp>` for the SAME database. A
 *     directory somebody else put in that folder — an older dump, a copy, a
 *     note — is never a candidate, whatever the count says.
 *   - IT NEVER REMOVES THE BACKUP JUST TAKEN, even if `keep` is 1 and the
 *     sort is somehow wrong.
 *   - IT NEVER REMOVES THE NEWEST, for the same reason.
 *
 * The decision is pure and the deleting is the caller's, so every rule above
 * can be tested without a filesystem.
 */

/** `eje-<database>-<stamp>`, as `planBackup` builds it. */
const NAME = /^eje-(?<database>.+)-(?<stamp>\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)$/u;

export interface BackupDirectoryName {
  readonly name: string;
  readonly database: string;
  readonly stamp: string;
}

export const readBackupDirectoryName = (name: string): BackupDirectoryName | null => {
  const match = NAME.exec(name);
  const database = match?.groups?.database ?? '';
  const stamp = match?.groups?.stamp ?? '';
  if (database.length === 0 || stamp.length === 0) return null;
  return { name, database, stamp };
};

/**
 * How many to keep, from the environment.
 *
 * Anything that is not a whole number above zero means "keep everything",
 * including a typo: the failure mode of a misread retention setting must be a
 * full disk, never a deleted backup.
 */
export const readRetention = (env: Readonly<Record<string, string | undefined>>): number | null => {
  const configured = (env.EJE_BACKUP_KEEP ?? '').trim();
  if (!/^[0-9]+$/u.test(configured)) return null;
  const keep = Number(configured);
  return keep >= 1 ? keep : null;
};

export interface PruneDecision {
  readonly remove: readonly string[];
  readonly kept: readonly string[];
  /** Why nothing was removed, when nothing was. For the operator, not a log. */
  readonly note: string;
}

export const chooseBackupsToPrune = (input: {
  /** Every entry in the backup directory, directories and otherwise. */
  readonly entries: readonly string[];
  readonly databaseName: string;
  /** The directory name this run has just written. Never a candidate. */
  readonly justWritten: string;
  readonly keep: number | null;
}): PruneDecision => {
  if (input.keep === null) {
    return {
      remove: [],
      kept: input.entries,
      note: 'EJE_BACKUP_KEEP is not set to a whole number above zero, so every backup is kept.',
    };
  }

  const mine = input.entries
    .map(readBackupDirectoryName)
    .filter((entry): entry is BackupDirectoryName => entry !== null)
    .filter((entry) => entry.database === input.databaseName)
    /*
     * NEWEST FIRST, by the stamp in the NAME rather than by a filesystem time.
     * `backupStamp` is fixed-width and ISO-ordered precisely so a string sort
     * is a time sort; an mtime, by contrast, changes when a manifest is
     * appended to by a verification, which would reorder the shelf and delete
     * the wrong thing.
     */
    .sort((left, right) => right.stamp.localeCompare(left.stamp));

  const removable = mine.slice(input.keep).filter((entry) => entry.name !== input.justWritten);
  const keptNames = mine
    .slice(0, input.keep)
    .map((entry) => entry.name)
    .concat(input.justWritten);

  return {
    remove: removable.map((entry) => entry.name),
    kept: [...new Set(keptNames)],
    note:
      removable.length === 0
        ? `${mine.length} backup(s) of ${input.databaseName} present, keeping ${input.keep}: ` +
          'nothing to remove yet.'
        : `keeping the ${input.keep} newest backup(s) of ${input.databaseName}.`,
  };
};

/** The name a run writes, for callers that need it before the directory exists. */
export const backupDirectoryName = (databaseName: string, now: Date): string =>
  `eje-${databaseName}-${backupStamp(now)}`;
