import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit configuration.
 *
 * `generate` needs no database — it diffs the schema against the migration
 * journal — so a migration can be produced and reviewed without a server
 * running. Only `migrate` and `studio` connect.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/eje_dev',
  },
  // Every constraint and index in this schema is named deliberately, so the
  // generated SQL should carry those names rather than invent its own.
  breakpoints: true,
  strict: true,
  verbose: true,
});
