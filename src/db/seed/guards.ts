import {
  classifyDatabaseUrl,
  DEVELOPMENT_NAMES,
  LOCAL_HOSTS,
  PRODUCTION_MARKERS,
} from '@/db/connection-guard';

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

/*
 * The same names the APPLICATION's connection guard uses.
 *
 * Imported rather than restated: two lists that are meant to agree and are
 * written down twice are two lists that will one day disagree, and the one
 * that is wrong will be whichever is protecting the live database that day.
 */

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
 *  2. A database or host that NAMES itself production refuses outright. No
 *     override — see the comment at that check.
 *  3. A local host, or a database whose name says development, proceeds.
 *  4. Anything else — a remote host with an unrevealing name — is treated as
 *     possibly production and needs `EJE_SEED_ALLOW=i-understand`, which is a
 *     deliberate act. Refusing to guess is the point.
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
    /*
     * NO OVERRIDE, and `db:reset` has never had one for this case either.
     *
     * It used to take `EJE_SEED_ALLOW=i-understand`, for the developer whose
     * own copy happened to carry the word. That reading is not worth what it
     * costs now: EJE has a real `eje_production` on a real VPS, the deployment
     * runbook tells an operator to source an environment file that names it,
     * and one remembered incantation would write fictional customers and
     * accounts whose password is published in `docs/` straight into it. Rename
     * the copy instead — that is a second of typing, and it is reversible.
     */
    throw new SeedRefused(
      `"${databaseName}" on ${host} names itself as production. The development seed writes ` +
        'fictional customers and accounts whose password is published in the documentation, and ' +
        'it will not run here. There is no override. If this really is a development copy, give ' +
        'it a name that says so.',
    );
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

const CONFIRM = 'EJE_RESET_CONFIRM';

export interface ResetEnvironment {
  readonly NODE_ENV?: string | undefined;
  readonly DATABASE_URL?: string | undefined;
  readonly EJE_RESET_CONFIRM?: string | undefined;
}

export interface ResetTarget {
  readonly url: string;
  readonly databaseName: string;
  readonly host: string;
}

/** Decides whether this database may be destroyed, and says exactly why not. */
export const resolveResetTarget = (env: ResetEnvironment): ResetTarget => {
  if ((env.NODE_ENV ?? '').toLowerCase() === 'production') {
    throw new SeedRefused(
      'NODE_ENV is "production". This command empties a database and rebuilds it with fictional ' +
        'demonstration data. It will not run here, and there is no override.',
    );
  }

  const url = (env.DATABASE_URL ?? '').trim();
  if (url.length === 0) {
    throw new SeedRefused(
      'DATABASE_URL is not set. Point it at your DEVELOPMENT database — see docs/database.md — ' +
        'and run this again.',
    );
  }

  const target = classifyDatabaseUrl(url);

  if (target.kind === 'production') {
    throw new SeedRefused(
      `"${target.databaseName}" on ${target.host} names itself as production. Refusing to empty it. ` +
        'There is no override for this command.',
    );
  }
  if (target.kind === 'unknown') {
    throw new SeedRefused(
      `DATABASE_URL points at "${target.databaseName}" on ${target.host}, which is neither a local ` +
        'host nor named as a development database. This command empties the database, so it will ' +
        'not assume that is safe. Rename it so it says development, or use a local one.',
    );
  }

  /*
   * The test database belongs to `db:test`.
   *
   * That suite rebuilds the public schema on every run, so two things would be
   * tearing down the same database on their own schedules. Refused outright
   * rather than overridable: there is no reason to reset a test database by
   * hand, because running the tests already does it.
   */
  if (/test/iu.test(target.databaseName)) {
    throw new SeedRefused(
      `"${target.databaseName}" is a TEST database. \`npm run db:test\` rebuilds it on every run ` +
        'and owns it; this command will not touch it. Point DATABASE_URL at your development database.',
    );
  }

  const confirmed = (env.EJE_RESET_CONFIRM ?? '').trim();
  if (confirmed !== target.databaseName) {
    throw new SeedRefused(
      `This will PERMANENTLY DELETE everything in "${target.databaseName}" on ${target.host} and ` +
        `rebuild it from the migrations and the development seed.\n\n` +
        `  To go ahead, name the database you mean to empty:\n\n` +
        `    ${CONFIRM}=${target.databaseName} npm run db:reset\n`,
    );
  }

  return { url, databaseName: target.databaseName, host: target.host };
};
