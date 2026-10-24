import { randomBytes } from 'node:crypto';
import { runPostgresTool } from './pg-client';
import { BackupRefused, backupStamp, redactSecrets } from './plan';

/**
 * THE DATABASE A RESTORE TEST IS ALLOWED TO BUILD AND DESTROY. BACKUP-2.
 *
 * Pure logic and one small server adapter, in their own file, so the guard can
 * be TESTED without running the command that uses it — the one mistake
 * `backup:restore-test` must never make is dropping the database somebody is
 * backing up, and "never" has to be provable rather than asserted in a comment.
 *
 * Nothing here takes a name from the manifest or from the command line. The
 * name is GENERATED, and then checked against both a pattern and the source
 * database's name.
 *
 * *Amended 17 October 2026, issue #23:* the name used to be the timestamp
 * alone, to the second, so two invocations starting inside the same second
 * computed the SAME name and the second was refused for a collision rather
 * than a real conflict. It now carries random bytes as well. The collision
 * check has not been relaxed to make room for that — it is the backstop, and
 * `claimScratchDatabase` below is what proves the two work together.
 *
 * *Amended 22 October 2026:* EIGHT random bytes rather than four. Four is
 * ample for the purpose — two restore tests starting in the same second
 * collide with probability 2^-32, and the collision check catches even that —
 * but it is not enough for anything to assert exact uniqueness over a large
 * sample, and the test that tried fails about one run in eighty. Sixteen hex
 * characters brings the whole name to 54, comfortably inside PostgreSQL's
 * 63-character limit, and costs nothing.
 */

const SCRATCH_PREFIX = 'eje_restore_test_';

/** Eight bytes of randomness, as sixteen characters a database name may carry. */
export const randomSuffix = (): string => randomBytes(8).toString('hex');

/**
 * The name this test will create and then drop. Generated, never supplied.
 *
 * The timestamp stays, and is first, because it is what makes a leftover
 * database legible to whoever finds one: `eje_restore_test_2026_10_17t…` says
 * when it was made. The random suffix is what makes two of them distinct.
 */
export const scratchDatabaseName = (now: Date, suffix: () => string = randomSuffix): string =>
  `${SCRATCH_PREFIX}${backupStamp(now).toLowerCase().replace(/[^0-9a-z]/gu, '_')}_${suffix()}`;

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

/**
 * The three things a restore test needs a PostgreSQL server to do.
 *
 * An interface rather than direct `psql` calls so that the claim logic can be
 * tested deterministically — including the case of two claims landing on the
 * same name, which is not something a test should have to provoke by timing.
 */
export interface ScratchServer {
  readonly exists: (name: string) => boolean;
  readonly create: (name: string) => void;
  readonly drop: (name: string) => void;
}

/**
 * Claims a brand-new scratch database, or refuses. BACKUP-2.
 *
 * TWO INDEPENDENT PROTECTIONS, DELIBERATELY BOTH KEPT.
 *
 *   1. The name carries four random bytes, so two invocations in the same
 *      second do not compute the same name in the first place.
 *   2. An existing database is REFUSED rather than replaced — so even if the
 *      names did collide, or a leftover from an interrupted run is sitting
 *      there, nothing is overwritten.
 *
 * The second is why the first is an improvement in reliability and not in
 * safety: the collision was never dangerous, it just failed a run that should
 * have succeeded.
 */
export const claimScratchDatabase = (
  server: ScratchServer,
  source: string,
  now: Date,
  suffix: () => string = randomSuffix,
): string => {
  const name = scratchDatabaseName(now, suffix);
  assertSafeToDrop(name, source);

  if (server.exists(name)) {
    throw new BackupRefused(
      `${name} already exists. Refused rather than replaced — drop it by hand if it is left ` +
        'over from an interrupted run. Nothing in it has been changed.',
    );
  }

  server.create(name);
  return name;
};

/** The real thing, driving `psql` against the server in `url`. */
export const postgresScratchServer = (url: string): ScratchServer => {
  const run = (sql: string): { ok: boolean; stdout: string; stderr: string } => {
    // The URL is passed as PG* variables and a password file, never as an argument.
    return runPostgresTool('psql', url, ['-v', 'ON_ERROR_STOP=1', '-At', '-c', sql]);
  };

  return {
    exists: (name) => {
      const answer = run(`SELECT 1 FROM pg_database WHERE datname = '${name}'`);
      if (!answer.ok) {
        throw new BackupRefused(`could not reach the server: ${redactSecrets(answer.stderr, url)}`);
      }
      return answer.stdout.trim() === '1';
    },
    create: (name) => {
      const created = run(`CREATE DATABASE ${name}`);
      if (!created.ok) {
        throw new BackupRefused(
          `could not create ${name}: ${redactSecrets(created.stderr, url)}`,
        );
      }
    },
    drop: (name) => {
      const dropped = run(`DROP DATABASE IF EXISTS ${name}`);
      if (!dropped.ok) {
        throw new BackupRefused(
          `${name} could not be dropped and is still on the server: ` +
            redactSecrets(dropped.stderr, url),
        );
      }
    },
  };
};
