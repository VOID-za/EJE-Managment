import { writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { assertProductionMigrationIntent, classifyDatabaseUrl } from './connection-guard';
import { databaseUrlFromEnv } from './client';
import { loadEnvFiles } from './seed/env';

/**
 * `npm run db:migrate`.
 *
 * DRIZZLE-KIT STILL DOES THE MIGRATING. This file adds nothing to how a
 * migration is applied — it runs `drizzle-kit migrate` in this process, with the
 * same configuration and the same driver. What it adds is the three things the
 * CLI does not do, each of which cost a working day to establish by hand:
 *
 *  1. IT SAYS WHERE IT IS GOING, before it goes there, and then asks the server
 *     itself who it is. A migration that silently succeeds against the wrong
 *     database is indistinguishable from one that worked.
 *  2. IT PRINTS THE ERROR. drizzle-kit 0.31.10 cannot — see below.
 *  3. IT SAYS WHAT HAPPENED afterwards, counted on the same connection that did
 *     the work, so "applied successfully" is a claim backed by a row count
 *     rather than a spinner frame.
 *
 * WHY (2) IS NECESSARY. In `node_modules/drizzle-kit/bin.cjs`:
 *
 *     MigrateProgress = class extends TaskView {
 *       render(status) {                                 // <- status ONLY
 *         if (status === 'pending' || status === 'rejected') {
 *           return `[${spin}] applying migrations...`;   // <- the error is dropped
 *         }
 *         return `[OK] migrations applied successfully!`;
 *       }
 *     };
 *
 * hanji's terminal calls `render('rejected', err)` and this `render` never
 * declares the second parameter, so the exception is discarded. `renderWithTask`
 * then calls `process.exit(1)` before the handler's own `catch (e) {
 * console.error(e) }` can run. The result is a command that exits 1 having
 * printed nothing at all — no message, no SQLSTATE, no statement. No amount of
 * redirection or output capture can recover it, because nothing is ever written.
 *
 * So the error is caught one layer lower instead. `PgDialect.prototype.migrate`
 * is the method drizzle-kit calls to do the work, and patching it here — in
 * memory, for this process only — puts a reporter between the migration and the
 * renderer that throws its arguments away. Nothing on disk is modified, and
 * `npx drizzle-kit migrate` remains exactly as it was.
 *
 * EVERYTHING IS WRITTEN WITH `writeSync`. `process.exit` discards whatever is
 * still queued on a piped stdout, which on Windows is most of it — that is the
 * second half of why the CLI appears to say nothing. A synchronous write to the
 * file descriptor cannot be lost that way.
 */

/** The part of the postgres-js client this file uses. */
interface Client {
  unsafe(query: string): Promise<ReadonlyArray<Record<string, unknown>>>;
}

/** The part of drizzle's session this file uses. */
interface Session {
  readonly client: Client;
}

const say = (line: string): void => {
  writeSync(1, `${line}\n`);
};

const warn = (line: string): void => {
  writeSync(2, `${line}\n`);
};

const first = async (client: Client, query: string): Promise<Record<string, unknown>> => {
  const rows = await client.unsafe(query);
  return rows[0] ?? {};
};

/**
 * Who answered.
 *
 * Asked of the server rather than read off the connection string, because the
 * question being settled is whether the two agree.
 */
const describeConnection = async (client: Client): Promise<void> => {
  const row = await first(
    client,
    'select current_database() as db, current_user as who, version() as server',
  );
  say(`   connected to  ${String(row['db'])} as ${String(row['who'])}`);
  say(`   server        ${String(row['server']).split(' on ')[0]}`);
};

/** What is actually there now, counted on the connection that just did the work. */
const describeOutcome = async (client: Client): Promise<void> => {
  let applied = 'NONE — drizzle.__drizzle_migrations does not exist';
  try {
    const row = await first(client, 'select count(*) as n from drizzle.__drizzle_migrations');
    applied = `${String(row['n'])} recorded in drizzle.__drizzle_migrations`;
  } catch {
    // Left as the sentence above. The table is created by the migrator before it
    // reads anything, so its absence is itself the finding.
  }
  const tables = await first(
    client,
    "select count(*) as n from pg_tables where schemaname = 'public'",
  );
  say(`   migrations    ${applied}`);
  say(`   public tables ${String(tables['n'])}`);
};

/**
 * The exception drizzle-kit throws away.
 *
 * drizzle wraps the driver error, so the SQLSTATE and the server's own text are
 * on `cause` rather than on the error itself — reading `error.code` gives
 * `undefined` and tells nobody anything.
 */
const describeFailure = (cause: unknown): void => {
  const error = cause as {
    message?: string;
    query?: string;
    cause?: {
      message?: string;
      code?: string;
      detail?: string;
      hint?: string;
      position?: string;
      routine?: string;
    };
  };
  const inner = error.cause;

  warn('');
  warn('MIGRATION FAILED. drizzle-kit does not print this itself:');
  warn(`   ${error.message ?? String(cause)}`);
  if (inner !== undefined) {
    warn(`   PostgreSQL    ${inner.message ?? '(no message)'}`);
    warn(`   SQLSTATE      ${inner.code ?? '(none)'}`);
    if (inner.detail !== undefined) warn(`   detail        ${inner.detail}`);
    if (inner.hint !== undefined) warn(`   hint          ${inner.hint}`);
    if (inner.position !== undefined) warn(`   position      ${inner.position}`);
    if (inner.routine !== undefined) warn(`   routine       ${inner.routine}`);
  }
  if (error.query !== undefined) {
    warn('   statement:');
    warn(`   ${error.query.slice(0, 500)}`);
  }
  warn('');
};

const main = async (): Promise<void> => {
  const files = loadEnvFiles();
  if (files.length > 0) say(`Read ${files.join(' and ')}.`);

  // The application's single reader: refuses a missing DATABASE_URL by name and
  // applies the connection guard. A migration cannot reach a database that
  // `npm run dev` would refuse to open.
  const url = databaseUrlFromEnv();
  const target = classifyDatabaseUrl(url);
  say(`EJE migrations → ${target.databaseName} on ${target.host} (${target.kind})`);

  /*
   * The second gate, and the only one that applies to the live database.
   *
   * Announced first, deliberately: an operator who is refused here should be
   * able to read the line above and see that the refusal is about the database
   * it names. See `assertProductionMigrationIntent`.
   */
  assertProductionMigrationIntent(url);

  /*
   * The reporter, installed before drizzle-kit loads.
   *
   * `drizzle-orm/pg-core` is imported here first, so when drizzle-kit does its
   * own `await import('drizzle-orm/postgres-js')` Node's module cache hands it
   * this same class and the patch is already in place.
   */
  const pgCore = await import('drizzle-orm/pg-core');
  const prototype = pgCore.PgDialect.prototype as unknown as {
    migrate: (migrations: readonly unknown[], session: Session, config: unknown) => Promise<void>;
  };
  const applyMigrations = prototype.migrate;

  prototype.migrate = async function report(migrations, session, config): Promise<void> {
    await describeConnection(session.client);
    say(`   applying      ${migrations.length} migrations`);
    try {
      await applyMigrations.call(this, migrations, session, config);
    } catch (cause) {
      describeFailure(cause);
      throw cause;
    }
    // Counted before drizzle-kit exits, on the connection that did the work.
    await describeOutcome(session.client);
  };

  const require_ = createRequire(resolve('package.json'));
  // `./bin.cjs` is not an exported subpath, so it is located from the package
  // root rather than required by name.
  const bin = join(dirname(require_.resolve('drizzle-kit')), 'bin.cjs');
  process.argv = [process.argv[0] ?? 'node', bin, 'migrate'];
  require_(bin);
};

main().catch((cause: unknown) => {
  warn(cause instanceof Error ? cause.message : String(cause));
  process.exit(1);
});
