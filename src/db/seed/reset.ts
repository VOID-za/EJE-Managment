import { spawnSync } from 'node:child_process';
import { sql } from 'drizzle-orm';
import { createDatabase } from '@/db/client';
import { loadEnvFiles } from './env';
import { resolveResetTarget, SeedRefused } from './guards';

/**
 * Re-baselining a DEVELOPMENT database.
 *
 * WHY THIS IS SEPARATE FROM `db:seed`. The seed is additive by design and must
 * stay that way — there is no `DROP`, `TRUNCATE` or `DELETE` anywhere in this
 * directory, which is what makes running it twice safe and what stops it
 * trampling work somebody did in the application. This command is the opposite
 * and says so in its name: it DESTROYS the contents of a development database
 * and builds it again from the migrations and that same seed.
 *
 * IT ADDS NO NEW MECHANISM. The schema comes from `npm run db:migrate` and the
 * data from `npm run db:seed`, both run as child processes against the same
 * `DATABASE_URL`. This file contributes exactly one thing they do not do:
 * emptying the database first. Running the real commands rather than
 * reimplementing them is also what keeps `__drizzle_migrations` correct
 * afterwards, so the next `db:migrate` sees a database that is up to date
 * rather than one it wants to rebuild.
 *
 * FOUR THINGS HAVE TO BE TRUE before it drops anything. They are not
 * convenience checks — this is the only destructive command in the repository
 * that a person is expected to run by hand:
 *
 *  1. `NODE_ENV` is not `production`. No override, ever.
 *  2. The target is a LOCAL or DEVELOPMENT-named database. A production name,
 *     or a remote host whose name says nothing, is refused. Refusing to guess
 *     is the point — see `connection-guard.ts`.
 *  3. The database is not a TEST database. `db:test` owns those and rebuilds
 *     them on every run; a reset pointed at one would be racing it.
 *  4. `EJE_RESET_CONFIRM` names the database, exactly. Typing the name of the
 *     thing being destroyed is the cheapest confirmation that actually proves
 *     somebody knows what they are pointed at — a bare `--yes` proves nothing,
 *     because the whole failure mode is not knowing.
 */
/**
 * Empties the database by rebuilding its schema.
 *
 * `DROP SCHEMA public CASCADE` rather than truncating every table: the
 * immutability triggers deliberately refuse a DELETE on the historical tables,
 * the migrations create functions, sequences and extensions as well as tables,
 * and dropping the schema is the only thing that genuinely returns the database
 * to "before any migration ran". `db:migrate` then builds all of it back.
 *
 * AND THE `drizzle` SCHEMA WITH IT, which is the part that is easy to miss.
 * The migration journal is `drizzle.__drizzle_migrations`, NOT a table in
 * `public` — so dropping `public` alone leaves drizzle-kit believing all seven
 * migrations are still applied. It then applies none of them, reports success,
 * and hands back an empty database. That failure is silent and it is the whole
 * reason this is two statements rather than one.
 */
const emptySchema = async (url: string): Promise<void> => {
  const db = createDatabase({ connectionString: url, maxConnections: 1 });
  try {
    await db.execute(sql`drop schema if exists public cascade`);
    // The bookkeeping, so `db:migrate` genuinely starts from nothing.
    await db.execute(sql`drop schema if exists drizzle cascade`);
    await db.execute(sql`create schema public`);
    // The extensions live in `public` and went with it; the migrations create
    // them again. Nothing else here assumes anything about who owns the schema.
  } finally {
    await db.$client.end({ timeout: 5 });
  }
};

/** Runs one of the project's own npm scripts against the same environment. */
const run = (script: string, url: string): void => {
  console.log(`\n→ npm run ${script}`);
  const result = spawnSync('npm', ['run', script], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
    shell: process.platform === 'win32',
  });

  if (result.status !== 0) {
    throw new SeedRefused(
      `\`npm run ${script}\` failed. The database has been emptied but not rebuilt — fix the ` +
        'problem above and run this command again.',
    );
  }
};

const main = async (): Promise<void> => {
  const files = loadEnvFiles();
  if (files.length > 0) console.log(`Read ${files.join(' and ')}.`);

  const target = resolveResetTarget(process.env);

  console.log(`EJE development reset → ${target.databaseName} on ${target.host}`);
  console.log('Emptying the database, applying every migration, then seeding.\n');

  await emptySchema(target.url);
  console.log('Schema dropped and recreated.');

  run('db:migrate', target.url);
  run('db:seed', target.url);

  console.log(`\n${target.databaseName} is back to a known development state.`);
};

main().catch((cause: unknown) => {
  if (cause instanceof SeedRefused) {
    console.error(`\nRefused: ${cause.message}\n`);
    process.exit(2);
  }
  console.error(cause);
  process.exit(1);
});
