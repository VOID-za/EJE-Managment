import { createDatabase } from '@/db/client';
import { announceAccounts, applySeed, closeConnection, requireSchema, summarise } from './apply';
import { loadEnvFiles } from './env';
import { resolveDemoSeedTarget, SeedRefused } from './guards';

/**
 * `npm run db:seed:demo` — the same fictional dataset, for the TEST DEPLOYMENT.
 *
 * WHY THIS EXISTS AT ALL. eje.syncza.co.za is a staging site with a database
 * called `eje_production`, and it is useless empty: there is nothing to sign
 * into, no job to open, no dashboard to read. `npm run db:seed` will not fill
 * it and must not be made to — that command's refusal of a production name is
 * what stops somebody writing published credentials into the eventual live
 * system, and weakening it to solve a staging problem would trade a permanent
 * protection for a temporary convenience.
 *
 * So the refusal stays and this is a SECOND DOOR with its own lock, in the
 * shape `EJE_PRODUCTION_MIGRATION` and `EJE_RESET_CONFIRM` already use: name
 * the database. `EJE_PRODUCTION_DEMO_SEED=eje_production` cannot be set once in
 * a profile and forgotten, cannot arrive by sourcing an environment file
 * written for something else, and reads in a deployment log as exactly what it
 * is — somebody deciding, for one named database, that published demonstration
 * accounts belong in it.
 *
 * IT IS NOT A BYPASS AND IT IS NOT BROADER. Everywhere that is not production,
 * this command behaves exactly as `npm run db:seed` does, because it delegates
 * to the same guard. The only thing it adds is a way to say yes to one
 * database, out loud.
 *
 * WHEN EJE GOES LIVE, this command is never run against the live database and
 * the accounts below are never created there. That is a sentence in
 * `docs/database.md` and in the output of every run.
 */
const main = async (): Promise<void> => {
  const resetPasswords = process.argv.includes('--reset-passwords');

  const files = loadEnvFiles();
  if (files.length > 0) console.log(`Read ${files.join(' and ')}.`);

  const target = resolveDemoSeedTarget(process.env);

  console.log(`EJE DEMO seed → ${target.databaseName} on ${target.host}`);
  console.log(
    'This writes fictional demonstration data, including accounts whose password is published\n' +
      'in this repository. It never deletes anything. It is for a TEST environment only.\n',
  );

  const db = createDatabase({ connectionString: target.url, maxConnections: 2 });
  const startedAt = Date.now();
  try {
    await requireSchema(db);
    await applySeed(db, { resetPasswords });
    summarise(startedAt);
    announceAccounts('DEMO-ONLY');
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
