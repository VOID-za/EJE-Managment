import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Database integration tests.
 *
 * Separate from `npm test` on purpose: the unit suite must keep running with
 * nothing installed beyond the project, on a machine with no PostgreSQL. These
 * tests need a real server and are run deliberately, with `npm run db:test`.
 *
 * Every test in `*.db.test.ts` skips itself when `TEST_DATABASE_URL` is unset,
 * so the command is safe to run anywhere — it reports skipped rather than
 * failing on an absent database.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.db.test.ts'],
    // One database, one connection: parallel files would truncate each other's
    // tables mid-test.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
