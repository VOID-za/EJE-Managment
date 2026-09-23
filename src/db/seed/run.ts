import { createDatabase } from '@/db/client';
import { announceAccounts, applySeed, closeConnection, requireSchema, summarise } from './apply';
import { loadEnvFiles } from './env';
import { resolveSeedTarget, SeedRefused } from './guards';

/**
 * `npm run db:seed` — a developer's own database, and nothing else.
 *
 * The seed itself is `./apply.ts` and is shared with `npm run db:seed:demo`.
 * All this file decides is WHICH database may receive it, and the answer here
 * is the strict one: a local host or a name that says development. A database
 * that names itself production is refused outright and there is no override —
 * seeding the staging deployment is a different command with a different
 * acknowledgement, written down in `./guards.ts` and `docs/database.md`.
 */
const main = async (): Promise<void> => {
  const resetPasswords = process.argv.includes('--reset-passwords');

  // `next dev` reads these; a command-line script has to be told to.
  const files = loadEnvFiles();
  if (files.length > 0) console.log(`Read ${files.join(' and ')}.`);

  const target = resolveSeedTarget(process.env);

  console.log(`EJE development seed → ${target.databaseName} on ${target.host}`);
  console.log('This writes fictional demonstration data. It never deletes anything.\n');

  const db = createDatabase({ connectionString: target.url, maxConnections: 2 });
  const startedAt = Date.now();
  try {
    await requireSchema(db);
    await applySeed(db, { resetPasswords });
    summarise(startedAt);
    announceAccounts('DEVELOPMENT-ONLY');
  } finally {
    await closeConnection(db);
  }
};

main().catch((cause: unknown) => {
  if (cause instanceof SeedRefused) {
    console.error(`\nRefused: ${cause.message}\n`);
    process.exit(2);
  }
  console.error(cause);
  process.exit(1);
});
