/**
 * What stops a DEVELOPMENT process connecting to EJE's live database.
 *
 * THE MISTAKE THIS EXISTS FOR. A developer copies a `.env` line to check
 * something, runs `npm run dev`, and is now signed into the real system with
 * the demonstration switcher on screen and a seed command one keystroke away.
 * Nothing in the application noticed, because a connection string is a
 * connection string.
 *
 * THE RULE, and it is deliberately the one the development seed already uses
 * (`src/db/seed/guards.ts`) rather than a second opinion that could disagree
 * with it:
 *
 *  1. `NODE_ENV=production` — this IS production. The deployment has said so,
 *     and the guard steps aside entirely. It is not the job of a safety check
 *     to argue with a production deployment about its own database.
 *  2. `EJE_DATABASE_ALLOW=i-understand` — somebody has deliberately taken
 *     responsibility. One line, in the environment, never in a file that is
 *     committed.
 *  3. A database or host that NAMES itself production is refused.
 *  4. A local host, or a database whose name says development, proceeds.
 *  5. ANYTHING ELSE IS REFUSED. A remote host with an unrevealing name is
 *     treated as possibly production, because the alternative is to guess —
 *     and the whole value of this check is that it does not.
 *
 * WHAT IT CANNOT DO. It works from names, because names are all this repository
 * has: nothing here establishes what EJE's production database will be called,
 * and inventing one would be worse than useless. Rule 5 is what makes that
 * honest — an unnamed database is refused rather than assumed safe. The real
 * protection is still separate credentials that a development machine never
 * holds, which is deployment configuration and is documented as such in
 * `docs/database.md`.
 */

/** Hosts a development database is actually likely to be on. */
export const LOCAL_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  'host.docker.internal',
  'db',
  'postgres',
]);

/** Names that say, in the URL itself, that this is not somebody's live data. */
export const DEVELOPMENT_NAMES =
  /(^|[-_])(dev|development|demo|local|test|sandbox|staging)([-_]|$)/iu;

export const PRODUCTION_MARKERS = /(^|[-_])(prod|production|live)([-_]|$)/iu;

export class ProductionDatabaseRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductionDatabaseRefused';
  }
}

export type DatabaseKind =
  /** A host this machine can reach only because it is this machine. */
  | 'local'
  /** Named as development, wherever it is. */
  | 'development'
  /** Named as production. */
  | 'production'
  /** Remote, and the name says nothing. Treated as possibly production. */
  | 'unknown';

export interface DatabaseTarget {
  readonly databaseName: string;
  readonly host: string;
  readonly kind: DatabaseKind;
}

/**
 * What a connection string appears to be pointing at.
 *
 * Never throws for an unparseable URL — it reports `unknown`, which the caller
 * refuses anyway. A URL nobody can read is exactly the case that must not be
 * assumed safe.
 */
export const classifyDatabaseUrl = (url: string): DatabaseTarget => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { databaseName: '', host: '', kind: 'unknown' };
  }

  const databaseName = parsed.pathname.replace(/^\//u, '');
  const host = parsed.hostname;

  // Production first: a database called `eje_prod_test` is production wearing a
  // development word, and the more dangerous reading wins.
  if (PRODUCTION_MARKERS.test(databaseName) || PRODUCTION_MARKERS.test(host)) {
    return { databaseName, host, kind: 'production' };
  }
  if (LOCAL_HOSTS.has(host)) return { databaseName, host, kind: 'local' };
  if (DEVELOPMENT_NAMES.test(databaseName)) return { databaseName, host, kind: 'development' };
  return { databaseName, host, kind: 'unknown' };
};

export interface ConnectionEnvironment {
  readonly NODE_ENV?: string | undefined;
  readonly EJE_DATABASE_ALLOW?: string | undefined;
}

const OVERRIDE = 'i-understand';

/**
 * Refuses the connection, or says nothing at all.
 *
 * Called from `databaseUrlFromEnv`, which is the single place the application
 * reads its connection string — so there is no second door into the pool.
 */
export const assertDevelopmentDatabase = (
  url: string,
  env: ConnectionEnvironment = process.env,
): void => {
  // This IS production. Nothing to protect it from.
  if ((env.NODE_ENV ?? '').toLowerCase() === 'production') return;

  if ((env.EJE_DATABASE_ALLOW ?? '').trim().toLowerCase() === OVERRIDE) return;

  const target = classifyDatabaseUrl(url);
  if (target.kind === 'local' || target.kind === 'development') return;

  const where =
    target.databaseName.length === 0
      ? 'DATABASE_URL could not be read as a URL'
      : `DATABASE_URL points at "${target.databaseName}"${target.host.length > 0 ? ` on ${target.host}` : ''}`;

  const because =
    target.kind === 'production'
      ? 'which names itself as production'
      : 'which is neither a local host nor named as a development database, so this will not assume it is safe';

  throw new ProductionDatabaseRefused(
    `${where}, ${because}. This process is not running as production ` +
      `(NODE_ENV=${env.NODE_ENV ?? 'undefined'}), and a development process must not connect to a ` +
      'live database by accident. Point DATABASE_URL at your development database — see ' +
      'docs/database.md — or, if you genuinely mean to do this, re-run with ' +
      `EJE_DATABASE_ALLOW=${OVERRIDE}.`,
  );
};
