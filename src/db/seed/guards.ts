/**
 * What stops this being run against EJE's real database.
 *
 * The seed writes fictional customers, fictional jobs and accounts whose
 * password is printed in the documentation. None of that belongs anywhere near
 * production, and "be careful" is not a control — so the checks are here, they
 * run before a connection is opened, and the only way past them is to say out
 * loud, in the environment, that this is a development database.
 *
 * NOTHING HERE IS DESTRUCTIVE AND NOTHING ELSE IN THE SEED IS EITHER. There is
 * no drop, no truncate and no delete in the whole of `src/db/seed`. The worst a
 * misdirected run could do is ADD demonstration records — which is bad enough,
 * and is what these checks are for.
 */
export interface SeedEnvironment {
  readonly NODE_ENV?: string | undefined;
  readonly DATABASE_URL?: string | undefined;
  readonly EJE_SEED_ALLOW?: string | undefined;
}

export class SeedRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedRefused';
  }
}

/** Hosts a development database is actually likely to be on. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal', 'db', 'postgres']);

/** Names that say, in the URL itself, that this is not somebody's live data. */
const DEVELOPMENT_NAMES = /(^|[-_])(dev|development|demo|local|test|sandbox|staging)([-_]|$)/iu;

const PRODUCTION_MARKERS = /(^|[-_])(prod|production|live)([-_]|$)/iu;

export interface SeedTarget {
  readonly url: string;
  readonly databaseName: string;
  readonly host: string;
}

/**
 * Decides whether this URL may be seeded, and says exactly why when it may not.
 *
 * The rule, in order:
 *
 *  1. `NODE_ENV=production` refuses outright. No override.
 *  2. A database or host that NAMES itself production refuses unless
 *     `EJE_SEED_ALLOW=i-understand` is set, which is a deliberate act.
 *  3. A local host, or a database whose name says development, proceeds.
 *  4. Anything else — a remote host with an unrevealing name — is treated as
 *     possibly production and needs the same explicit override. Refusing to
 *     guess is the point.
 */
export const resolveSeedTarget = (env: SeedEnvironment): SeedTarget => {
  if ((env.NODE_ENV ?? '').toLowerCase() === 'production') {
    throw new SeedRefused(
      'NODE_ENV is "production". The development seed writes fictional customers and accounts ' +
        'whose password is published in the documentation, and it will not run here. There is no override.',
    );
  }

  const url = (env.DATABASE_URL ?? '').trim();
  if (url.length === 0) {
    throw new SeedRefused(
      'DATABASE_URL is not set. Point it at your DEVELOPMENT database — see docs/database.md — and run this again.',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SeedRefused('DATABASE_URL could not be read as a URL.');
  }

  const databaseName = parsed.pathname.replace(/^\//u, '');
  const host = parsed.hostname;
  const allowed = (env.EJE_SEED_ALLOW ?? '').trim().toLowerCase() === 'i-understand';

  if (PRODUCTION_MARKERS.test(databaseName) || PRODUCTION_MARKERS.test(host)) {
    if (!allowed) {
      throw new SeedRefused(
        `"${databaseName}" on ${host} names itself as production. Refusing. ` +
          'If this really is a development copy, re-run with EJE_SEED_ALLOW=i-understand.',
      );
    }
    return { url, databaseName, host };
  }

  if (LOCAL_HOSTS.has(host) || DEVELOPMENT_NAMES.test(databaseName)) {
    return { url, databaseName, host };
  }

  if (!allowed) {
    throw new SeedRefused(
      `DATABASE_URL points at "${databaseName}" on ${host}, which is neither a local host nor named ` +
        'as a development database, so this seed will not assume it is safe. ' +
        'If it is a development database, re-run with EJE_SEED_ALLOW=i-understand.',
    );
  }

  return { url, databaseName, host };
};
