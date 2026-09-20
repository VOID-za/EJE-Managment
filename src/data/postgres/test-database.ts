import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { createDatabase, type Database } from '@/db/client';

/**
 * A real PostgreSQL database, for the integration tests.
 *
 * Deliberately NOT part of `npm test`. The unit suite runs on a machine with
 * nothing installed beyond the project, and it must stay that way — 900-odd
 * tests that need a database server are tests that stop being run.
 * `npm run db:test` is the deliberate command.
 *
 * Everything here is test infrastructure and is never imported by the
 * application.
 */

const MIGRATIONS_DIR = join(process.cwd(), 'src/db/migrations');

/**
 * The test connection string, or null when there is none.
 *
 * Returning null rather than throwing is what lets a test file skip itself, so
 * `npm run db:test` reports "skipped" on a machine with no PostgreSQL instead
 * of failing.
 */
export const testDatabaseUrl = (): string | null => {
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined || url.trim().length === 0) return null;

  /*
   * A guard, not a formality.
   *
   * These tests truncate every table. Pointing them at a development or
   * production database would destroy it, and the mistake is one wrong line in
   * a `.env` file away. The name has to say it is a test database.
   */
  const databaseName = url.split('/').pop()?.split('?')[0] ?? '';
  if (!/test/i.test(databaseName)) {
    throw new Error(
      `TEST_DATABASE_URL points at "${databaseName}", which is not named as a test database. ` +
        'These tests TRUNCATE every table. Use a database whose name contains "test".',
    );
  }
  return url;
};

/** Applies every migration, in journal order. */
export const applyMigrations = async (db: Database): Promise<void> => {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const contents = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    for (const statement of contents.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed.length === 0) continue;
      await db.execute(sql.raw(trimmed));
    }
  }
};

/**
 * Empties every table, leaving the schema in place.
 *
 * `TRUNCATE ... CASCADE` rather than deleting rows, because the immutability
 * triggers deliberately refuse a DELETE on the historical tables — which is the
 * behaviour being tested, so the tests cannot rely on being able to delete.
 */
export const truncateAll = async (db: Database): Promise<void> => {
  await db.execute(sql`
    do $$
    declare
      statement text;
    begin
      select 'truncate table ' || string_agg(format('%I.%I', schemaname, tablename), ', ') || ' cascade'
        into statement
        from pg_tables
       where schemaname = 'public'
         and tablename <> '__drizzle_migrations';

      if statement is not null then
        execute statement;
      end if;
    end $$;
  `);
  await db.execute(sql`select setval('eje_job_number_seq', 1068, false)`);
};

/**
 * Opens the test database on a schema built from scratch.
 *
 * The public schema is dropped and rebuilt before the migrations run, so a test
 * run is deterministic whatever state the previous one left behind — and so
 * that the migrations themselves are genuinely exercised on every run rather
 * than assumed to have worked once. They are not written to be idempotent, and
 * they should not be: a migration that quietly skips work it has already done
 * is a migration that cannot tell you it did not run.
 *
 * Safe because `testDatabaseUrl` has already refused any database not named as
 * a test database.
 */
export const openTestDatabase = async (url: string): Promise<Database> => {
  const db = createDatabase({ connectionString: url, maxConnections: 2 });
  await db.execute(sql`drop schema if exists public cascade`);
  await db.execute(sql`create schema public`);
  await applyMigrations(db);
  return db;
};
