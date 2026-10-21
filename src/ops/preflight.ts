import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import postgres from 'postgres';
import { loadEnvFiles } from '@/db/seed/env';
import {
  checkBackend,
  checkBackupKey,
  checkDatabaseTarget,
  checkDemoSwitcher,
  checkDeployment,
  checkEmail,
  checkMigrations,
  checkRuntime,
  checkStorage,
  fail,
  ok,
  passed,
  warn,
  type Check,
} from './preflight-rules';

/**
 * `npm run preflight` — WOULD THIS MACHINE ACTUALLY SERVE EJE? ARCH-5.
 *
 * Run it on the machine, as the service user, with the service's own
 * environment file, BEFORE `systemctl start`:
 *
 *   sudo -u eje --preserve-env=PATH env $(sudo cat /etc/eje/eje.env | xargs) \\
 *     npm run preflight -- --expect-db eje_staging
 *
 * It reads the configuration, opens the database, looks at the disk, and prints
 * one line per check. It exits non-zero if anything FAILED, so a deployment
 * script can stop instead of starting a server that looks healthy and is
 * quietly wrong — see `preflight-rules.ts` for the six silent failures this
 * exists for.
 *
 * IT CHANGES NOTHING. One `select 1`, one read of the migrations table, and one
 * probe file written into the storage directory and deleted again. No
 * migration, no seed, no truncate, no write to any application table — and it
 * is deliberately safe to run against production, because the moment before a
 * deployment is exactly when somebody needs to know.
 *
 * IT PRINTS NO VALUES. Not a password, not a token, not a host, not the length
 * of a secret. The output of this command ends up pasted into messages.
 */

const argument = (name: string): string | null => {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
};

/** The migration tags the repository ships, from drizzle's own journal. */
const shippedMigrations = (): readonly string[] => {
  const journal = resolve('src/db/migrations/meta/_journal.json');
  if (!existsSync(journal)) return [];
  try {
    const parsed = JSON.parse(readFileSync(journal, 'utf8')) as {
      entries?: { tag?: string }[];
    };
    return (parsed.entries ?? [])
      .map((entry) => entry.tag ?? '')
      .filter((tag) => tag.length > 0);
  } catch {
    return [];
  }
};

/**
 * How many migrations drizzle's ledger says have run, or null when the ledger
 * cannot be read at all.
 *
 * The ledger records a HASH and a timestamp rather than a tag, so the tags
 * cannot be matched one to one — but the journal is ordered, so a count is
 * enough to name the tail that is missing. Null and zero are deliberately
 * different answers: see `checkMigrations`.
 */
const appliedMigrationCount = async (
  sql: ReturnType<typeof postgres>,
): Promise<number | null> => {
  const rows = await sql<{ count: string }[]>`
    select count(*)::text as count from drizzle.__drizzle_migrations
  `.catch(() => null);
  if (rows === null) return null;
  const applied = Number(rows[0]?.count ?? '');
  return Number.isFinite(applied) ? applied : null;
};

const storageFacts = (configured: string) => {
  const applicationDirectory = resolve('.');
  if (configured.length === 0) {
    return { configured, exists: false, writable: false, insideApplication: false };
  }
  const path = resolve(configured);
  const exists = existsSync(path) && statSync(path).isDirectory();

  let writable = false;
  if (exists) {
    try {
      const probe = join(path, `.eje-preflight-${process.pid}`);
      writeFileSync(probe, 'preflight');
      rmSync(probe);
      writable = true;
    } catch {
      writable = false;
    }
  }

  return {
    configured,
    exists,
    writable,
    insideApplication: path === applicationDirectory || path.startsWith(`${applicationDirectory}/`),
  };
};

const LABEL: Readonly<Record<Check['verdict'], string>> = {
  ok: ' ok ',
  warn: 'WARN',
  fail: 'FAIL',
};

const main = async (): Promise<void> => {
  // The same loader the application uses, so preflight reads what the service
  // will read rather than a different idea of the environment.
  loadEnvFiles();
  const env = process.env;
  const expectDatabase = argument('expect-db');

  const checks: Check[] = [
    ...checkRuntime(env, {
      buildPresent: existsSync(resolve('.next/BUILD_ID')),
      buildCommit: (env.EJE_BUILD_COMMIT ?? '').trim(),
    }),
    ...checkBackend(env),
    ...checkDatabaseTarget(env, expectDatabase),
  ];

  const url = (env.DATABASE_URL ?? '').trim();
  if (url.length > 0) {
    /*
     * ONE CONNECTION, ONE STATEMENT EACH, AND A SHORT FUSE. A preflight that
     * hangs on an unreachable database is a preflight nobody runs.
     */
    const sql = postgres(url, { max: 1, connect_timeout: 10, idle_timeout: 2, onnotice: () => {} });
    try {
      const identity = await sql<{ db: string; version: string }[]>`
        select current_database() as db, version() as version
      `;
      const db = identity[0]?.db ?? '';
      const server = (identity[0]?.version ?? '').split(' ').slice(0, 2).join(' ');
      checks.push(ok('Database connection', `reached ${server}, serving "${db}".`));

      /*
       * THE SCHEMA FIRST, because it is what tells an empty migration ledger
       * apart from a database nothing has ever been applied to.
       */
      const people = await sql<{ count: string }[]>`select count(*)::text as count from users`
        .catch(() => null);

      checks.push(
        ...checkMigrations(shippedMigrations(), {
          applied: await appliedMigrationCount(sql),
          schemaPresent: people !== null,
        }),
      );

      if (people === null) {
        checks.push(
          fail(
            'Schema',
            'The `users` table could not be read. Either the migrations have not run here or ' +
              'this is not an EJE database.',
          ),
        );
      } else {
        const count = Number(people[0]?.count ?? '0');
        checks.push(
          count === 0
            ? warn('Accounts', 'The database holds no user accounts, so nobody can sign in yet.')
            : ok('Accounts', `${count} account(s) on the register.`),
        );
      }
    } catch (cause) {
      /*
       * The REASON, with the connection string kept out of it: a driver error
       * quotes what it was given, and what it was given carries a password.
       */
      const message = cause instanceof Error ? cause.message : 'unknown error';
      checks.push(
        fail(
          'Database connection',
          `Could not connect: ${message.split(url).join('[connection string]')}`,
        ),
      );
    } finally {
      await sql.end({ timeout: 5 }).catch(() => undefined);
    }
  }

  checks.push(
    ...checkStorage(storageFacts((env.EJE_STORAGE_DIR ?? '').trim())),
    ...checkBackupKey(env),
    ...checkEmail(env, (env.EJE_PERSISTENCE ?? '').trim().toLowerCase() === 'demo'),
    // Which deployment this is, before the feature that depends on it.
    ...checkDeployment(env),
    ...checkDemoSwitcher(env),
  );

  const width = Math.max(...checks.map((check) => check.name.length));
  process.stdout.write('\n=== EJE PREFLIGHT ===\n');
  if (expectDatabase !== null) {
    process.stdout.write(`expecting database "${expectDatabase}"\n`);
  }
  process.stdout.write('\n');
  for (const check of checks) {
    process.stdout.write(`[${LABEL[check.verdict]}] ${check.name.padEnd(width)}  ${check.detail}\n`);
  }

  const failures = checks.filter((check) => check.verdict === 'fail');
  const warnings = checks.filter((check) => check.verdict === 'warn');
  process.stdout.write(
    `\n${checks.length} checks: ${failures.length} failed, ${warnings.length} warned.\n`,
  );
  if (!passed(checks)) {
    process.stdout.write(
      'PREFLIGHT FAILED — do not start the service until the FAIL lines above are dealt with.\n',
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    warnings.length === 0
      ? 'PREFLIGHT PASSED.\n'
      : 'PREFLIGHT PASSED, with warnings worth reading.\n',
  );
};

void main().catch((cause: unknown) => {
  process.stderr.write(
    `preflight  FAILED: ${cause instanceof Error ? cause.message : String(cause)}\n`,
  );
  process.exitCode = 1;
});
