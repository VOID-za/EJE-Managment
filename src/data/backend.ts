import type { RepositoryBundle } from './repositories';
import { getDatabase, type Database, type DatabaseExecutor } from '@/db/client';
import { createPostgresRepositories } from './postgres';
import { withTransaction } from './postgres/transaction';

/**
 * Which persistence the application is running against.
 *
 * THE COMPOSITION ROOT FOR DATA. One module decides, and it decides from the
 * SERVER'S environment — never from localStorage, a query string, a cookie or
 * anything else a browser can set. A data source a visitor can choose is not a
 * data source, and "the demo store" is a mode this business must be able to
 * rule out with certainty.
 *
 * `DATABASE_URL` is the switch, because it is the thing whose presence actually
 * means a database exists. `EJE_PERSISTENCE=demo` forces the demonstration
 * backend even where one is configured, which is what a sales laptop wants.
 */
export type PersistenceBackend = 'postgres' | 'demo';

export const selectPersistenceBackend = (
  env: Record<string, string | undefined> = process.env,
): PersistenceBackend => {
  if (env.EJE_PERSISTENCE === 'demo') return 'demo';
  if (env.EJE_PERSISTENCE === 'postgres') return 'postgres';
  const url = env.DATABASE_URL;
  return url !== undefined && url.trim().length > 0 ? 'postgres' : 'demo';
};

/**
 * A repository bundle bound to one transaction, for one operation.
 *
 * This is the shape every server-side entry point will use: open a
 * transaction, build the repositories on it, run the application operation
 * unchanged, commit. `addLabour` still simply calls `context.repos.jobs.save`
 * and knows nothing about SQL — which is the whole reason the repository
 * interface exists.
 *
 * NOT CALLED FROM THE BROWSER, and it cannot be: PostgreSQL is never exposed to
 * a client. The HTTP layer that will call this is the next phase; until it
 * exists, the browser demonstration runs on the demo repositories, which is
 * stated plainly in `AppProvider` rather than disguised.
 */
export const withRepositories = async <T>(
  work: (repos: RepositoryBundle, tx: DatabaseExecutor) => Promise<T>,
  db: Database = getDatabase(),
): Promise<T> =>
  withTransaction(db, async (tx) => work(createPostgresRepositories(tx), tx));

/**
 * A read-only bundle on the pool, with no transaction.
 *
 * For reads that touch several repositories and change nothing. A read still
 * gets a consistent answer per statement; what it does not get is a snapshot
 * across statements, which no screen in this application depends on.
 */
export const readRepositories = (db: Database = getDatabase()): RepositoryBundle =>
  createPostgresRepositories(db);
