import { defineConfig } from 'drizzle-kit';
import { loadEnvFiles } from './src/db/seed/env';
import { databaseUrlFromEnv } from './src/db/client';

/**
 * Drizzle Kit configuration.
 *
 * `generate` needs no database — it diffs the schema against the migration
 * journal — so a migration can be produced and reviewed without a server
 * running. Only `migrate`, `push` and `studio` connect.
 *
 * WHICH IS WHY THE URL IS A GETTER. `drizzle-kit` evaluates this whole module
 * for every command it runs, so reading the connection string eagerly would
 * make `generate` fail for anybody who has no database configured. Deferring it
 * means the commands that connect are the only ones that demand a connection
 * string, and the ones that do not stay usable with nothing installed.
 *
 * AND WHY THERE IS NO LONGER A FALLBACK. There used to be a default of
 * `postgres://localhost:5432/eje_dev`, and it is how a migration could appear
 * to run while touching nothing: `drizzle-kit` does not read `.env.local`, so
 * `DATABASE_URL` was undefined, the default quietly took over, and the command
 * went looking for a database on the developer's own machine instead of the one
 * they had configured. A missing connection string is now a refusal with a
 * sentence explaining it. Guessing at a database is how the wrong one gets
 * written to.
 */

/*
 * `.env.local` is where `docs/database.md` tells people to put `DATABASE_URL`,
 * and it is git-ignored so that a real connection string never reaches a
 * commit. `next dev` reads it; a command-line tool does not, so this does —
 * the same loader `db:seed` and `db:reset` already use rather than a second one
 * that could come to disagree with them.
 *
 * A variable ALREADY IN THE ENVIRONMENT still wins, so
 * `DATABASE_URL=… npm run db:migrate` keeps meaning exactly what it says.
 */
loadEnvFiles();

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dbCredentials: {
    /*
     * `databaseUrlFromEnv` is the application's single reader of this variable:
     * it refuses a missing one by name and then applies the connection guard.
     * Going through it is what stops a migration reaching a database that
     * `npm run dev` would have refused to open.
     */
    get url(): string {
      return databaseUrlFromEnv();
    },
  },
  // Every constraint and index in this schema is named deliberately, so the
  // generated SQL should carry those names rather than invent its own.
  breakpoints: true,
  strict: true,
  verbose: true,
});
