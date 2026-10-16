import { BackupRefused, backupStamp } from './plan';

/**
 * THE DATABASE A RESTORE TEST IS ALLOWED TO BUILD AND DESTROY. BACKUP-2.
 *
 * Pure, and in its own file, so the guard can be TESTED without running the
 * command that uses it — the one mistake `backup:restore-test` must never make
 * is dropping the database somebody is backing up, and "never" has to be
 * provable rather than asserted in a comment.
 *
 * Nothing here takes a name from the manifest or from the command line. The
 * scratch name is generated from the clock and then checked against both a
 * pattern and the source database's name.
 */

const SCRATCH_PREFIX = 'eje_restore_test_';

/** The name this test will create and then drop. Generated, never supplied. */
export const scratchDatabaseName = (now: Date): string =>
  `${SCRATCH_PREFIX}${backupStamp(now).toLowerCase().replace(/[^0-9a-z]/gu, '_')}`;

/**
 * Refuses anything but a generated scratch name, and anything equal to the
 * source. Called before the database is created and again before it is dropped.
 */
export const assertSafeToDrop = (scratch: string, source: string): void => {
  if (!new RegExp(`^${SCRATCH_PREFIX}[0-9a-z_]+$`, 'u').test(scratch)) {
    throw new BackupRefused(
      `refusing to work with the database name "${scratch}": a restore test only ever ` +
        `creates and drops a database called ${SCRATCH_PREFIX}…`,
    );
  }
  if (scratch === source) {
    throw new BackupRefused(
      `the scratch database name and the source database name are both "${source}". ` +
        'Refused — this command must never touch the database being backed up.',
    );
  }
};

/** The same server, a different database. */
export const withDatabase = (url: string, database: string): string => {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
};
