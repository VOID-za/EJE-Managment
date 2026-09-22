import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import { assertDevelopmentDatabase } from './connection-guard';

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

/**
 * PostgreSQL's timestamp text, as an ISO-8601 instant.
 *
 * The server sends `2026-09-20 12:00:00+00`, which is not ISO-8601. The domain
 * treats `IsoDateTime` as a string it can SORT and COMPARE — the activity feed
 * orders by `occurredAt.localeCompare`, the closed-job archive filters on
 * `closedAt >= from` — and mixing the two notations breaks every one of those
 * silently, because both are strings and both look like dates. So the driver
 * normalises on the way out.
 *
 * Still no `Date` objects: building one would reintroduce exactly the
 * local-timezone ambiguity `src/lib/business-time.ts` exists to remove. The
 * instant is parsed, expressed in UTC, and handed back as text.
 */
const toIsoInstant = (value: string): string => {
  const withT = value.replace(' ', 'T');
  // `+02` is how PostgreSQL writes a whole-hour offset; ISO-8601 wants `+02:00`.
  const zoned = /[+-]\d{2}$/.test(withT)
    ? `${withT}:00`
    : // No offset at all means a `timestamp without time zone`, which this
      // schema does not use. Read as UTC rather than as the server's local
      // time, which is the reading that cannot drift with a deployment.
      /[+-]\d{2}:\d{2}$|Z$/.test(withT)
      ? withT
      : `${withT}Z`;

  const parsed = new Date(zoned);
  // Anything unparseable is handed back untouched rather than turned into
  // "Invalid Date": a value nobody can read is better than a wrong one.
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
};

/** `timestamp` and `timestamptz`, in the driver's own numbering. */
const TIMESTAMP_OIDS = ['1114', '1184'] as const;

export const createDatabase = (options: DatabaseOptions) => {
  const client = postgres(options.connectionString, {
    max: options.maxConnections ?? 10,
    onnotice: () => {},
  });

  const db = drizzle(client, { schema, logger: options.debug === true });

  /*
   * Normalising the timestamps, AFTER drizzle has had the client.
   *
   * `drizzle()` installs a transparent parser for every date and timestamp oid,
   * overwriting whatever the driver was configured with — which is why passing
   * `types` to `postgres()` looks like it works and does nothing. Its intent is
   * right: no `Date` objects, because building one would reintroduce exactly
   * the local-timezone ambiguity `src/lib/business-time.ts` exists to remove.
   * What it leaves behind is PostgreSQL's own text, and that is not ISO-8601.
   *
   * So the two timestamp oids are re-parsed here and nothing else is touched:
   * `date` (1082) stays `YYYY-MM-DD` and `time` (1083) stays `HH:MM:SS`, both
   * of which are already what the domain wants.
   */
  const parsers = client.options.parsers as Record<string, (value: string) => unknown>;
  for (const oid of TIMESTAMP_OIDS) parsers[oid] = toIsoInstant;

  return db;
};

/**
 * Reads the connection string, says plainly when it is missing, and REFUSES a
 * live database to a process that is not production.
 *
 * The check is here because this is the one place the application reads the
 * variable — `getDatabase` is the only caller and there is no other door into
 * the pool. See `connection-guard.ts` for the rule and for what it cannot do.
 */
export const databaseUrlFromEnv = (): string => {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim().length === 0) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env.local and point it at a PostgreSQL database. See docs/database.md.',
    );
  }
  assertDevelopmentDatabase(url);
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
