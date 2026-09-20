import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

/**
 * The database connection.
 *
 * NOTHING CONNECTS AT IMPORT TIME. The demo runs entirely in the browser and
 * `npm test`, `npm run build` and the browser suites must all keep working with
 * no database present — so the pool is created on first use and the absence of
 * `DATABASE_URL` is an explicit, readable error rather than a crash during a
 * module graph walk.
 */

export type Database = ReturnType<typeof createDatabase>;

/** A handle that is either the pool or an open transaction. Operations take this. */
export type DatabaseExecutor = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

export interface DatabaseOptions {
  readonly connectionString: string;
  /**
   * Maximum pooled connections.
   *
   * One VPS, one application process, a handful of concurrent users. Ten is
   * generous; the default of the driver is higher than this deployment needs
   * and a large pool against a small Postgres is a way to exhaust it.
   */
  readonly maxConnections?: number;
  /** Logs every statement. Development only. */
  readonly debug?: boolean;
}

export const createDatabase = (options: DatabaseOptions) => {
  const client = postgres(options.connectionString, {
    max: options.maxConnections ?? 10,
    // The application reads and writes ISO strings; letting the driver build
    // `Date` objects would reintroduce exactly the local-timezone ambiguity
    // `src/lib/business-time.ts` exists to remove.
    types: {
      date: {
        to: 1184,
        from: [1082, 1114, 1184],
        serialize: (value: string) => value,
        parse: (value: string) => value,
      },
    },
    onnotice: () => {},
  });

  return drizzle(client, { schema, logger: options.debug === true });
};

/** Reads the connection string, and says plainly when it is missing. */
export const databaseUrlFromEnv = (): string => {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim().length === 0) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env.local and point it at a PostgreSQL database. See docs/database.md.',
    );
  }
  return url;
};

let shared: Database | null = null;

/**
 * The process-wide handle, created once.
 *
 * Lazy on purpose: importing this module must not open a socket, because the
 * demo, the test suite and the production build all import code that
 * transitively reaches it.
 */
export const getDatabase = (): Database => {
  if (shared === null) {
    shared = createDatabase({
      connectionString: databaseUrlFromEnv(),
      debug: process.env.DRIZZLE_DEBUG === 'true',
    });
  }
  return shared;
};

/** Drops the shared handle. For tests, which create their own. */
export const resetSharedDatabase = (): void => {
  shared = null;
};
