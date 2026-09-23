import 'server-only';
import type { PersistenceBackend } from '@/data/backend';
import type { RepositoryBundle } from '@/data/repositories';
import { classifyDatabaseUrl } from '@/db/connection-guard';
import { DEMO_PASSWORD, seedPeople } from '@/db/seed/people';
import { DEMO_PASSWORD as IN_MEMORY_DEMO_PASSWORD } from '@/server/auth/demo-store';

/**
 * The development user switcher.
 *
 * WHAT IT IS FOR: moving between the seeded demonstration accounts without
 * typing an email address and a password every time. Switching role is
 * something a developer does forty times an hour, and the login form is the
 * wrong instrument for it.
 *
 * WHAT IT IS NOT: a way around authentication. The switcher performs the REAL
 * sign-in on the server — it finds the account, verifies the DOCUMENTED
 * development password against the stored Argon2id hash, and issues an ordinary
 * session. Nothing is bypassed, nothing is faked, and the session it hands back
 * is indistinguishable from one the login form would have produced. Every
 * authorization rule then applies exactly as it always does, because there is
 * only one kind of session.
 *
 * THREE THINGS KEEP IT OUT OF A LIVE DEPLOYMENT, and all three must hold:
 *
 *  1. The deployment must not be running as production — OR must have named
 *     its own database in `EJE_DEMO_SWITCHER`. See below; that second door
 *     exists for the staging site and nothing else.
 *  2. The email must be one of the five accounts the development seed creates.
 *     A name is not enough: the list is read from the seed itself.
 *  3. The account's password must be the one published in
 *     `docs/development-seed.md`. An account with a real password cannot be
 *     switched into, so even a misconfigured deployment holding real people
 *     would hand this nothing.
 *
 * (3) IS THE ONE THAT ACTUALLY PROTECTS EJE'S LIVE SYSTEM, and it is worth
 * being plain about why. (1) and (2) are configuration, and configuration can
 * be copied to the wrong machine. (3) cannot: the live database's accounts
 * belong to real people whose passwords are not in this repository, so a
 * switcher turned on there by mistake would find five addresses that do not
 * exist and, if they somehow did, hashes that do not match. It fails closed on
 * the only thing an attacker cannot change from outside.
 */

/**
 * WHY `NODE_ENV` ALONE WAS NOT THE RIGHT CONDITION.
 *
 * It was, while "not production" meant "somebody's laptop". It stopped being
 * right the day EJE got a STAGING DEPLOYMENT: eje.syncza.co.za is a real
 * server, started by systemd, built by `next build` — so `NODE_ENV` is
 * `production` there and always will be, because that is what makes Next serve
 * a production build. The switcher therefore vanished from the one deployment
 * whose entire purpose is people trying the application out, and the only ways
 * back were to run a development build in production or to weaken the check.
 * Neither is acceptable.
 *
 * So the condition is no longer "which build is this" but "which database is
 * this", and it is asked in the shape the rest of this repository already uses
 * for a deliberate act — `EJE_PRODUCTION_MIGRATION`, `EJE_PRODUCTION_DEMO_SEED`,
 * `EJE_RESET_CONFIRM`: NAME IT. `EJE_DEMO_SWITCHER` must equal the database in
 * `DATABASE_URL`, so the line cannot be a `true` somebody pasted, cannot be
 * inherited from another machine's environment file without being wrong, and
 * reads in `/etc/eje/eje.env` as a sentence about one named database.
 *
 * It is deliberately the same database the demo seed filled. A deployment that
 * has demonstration accounts in it is a deployment where switching between them
 * is the point; a deployment that does not is one where this finds nothing.
 */
export const DEMO_SWITCHER = 'EJE_DEMO_SWITCHER';

export interface SwitcherEnvironment {
  readonly NODE_ENV?: string | undefined;
  readonly EJE_DEMO_SWITCHER?: string | undefined;
  readonly DATABASE_URL?: string | undefined;
}

export const isDemoSwitcherEnabled = (env: SwitcherEnvironment = process.env): boolean => {
  // Not a production build: a developer's own machine, and `npm test`.
  if ((env.NODE_ENV ?? '').toLowerCase() !== 'production') return true;

  const declared = (env.EJE_DEMO_SWITCHER ?? '').trim();
  if (declared.length === 0) return false;

  /*
   * It has to name THIS deployment's database.
   *
   * `classifyDatabaseUrl` is borrowed rather than re-parsed: it is the same
   * reader the connection guard and both seeds use, so "what is this database
   * called" has one answer in this repository rather than four.
   */
  const { databaseName } = classifyDatabaseUrl(env.DATABASE_URL ?? '');
  return databaseName.length > 0 && declared === databaseName;
};

/** The accounts it may switch into, read from the seed rather than restated. */
export const DEMO_ACCOUNTS = seedPeople.map(({ user }) => ({
  email: user.email.toLowerCase(),
  firstName: user.firstName,
  lastName: user.lastName,
  role: user.role,
}));

/**
 * One sentence, whatever went wrong. This is a development tool, not an oracle.
 */
export const SWITCH_REFUSED = 'That development account cannot be switched into.';

/**
 * The one refusal worth explaining, because it is not really a refusal.
 *
 * A database that has been MIGRATED BUT NOT SEEDED has the whole schema and no
 * people in it. The list endpoint still returns the five accounts — deliberately,
 * so the control does not vanish on an unseeded database — and then every switch
 * answers 404, which reads as a missing route rather than an empty register.
 * That is precisely the dead end this sentence exists to end.
 *
 * Nothing is disclosed by saying it. These five addresses are what the list
 * endpoint just returned, and that endpoint answers 404 unless the deployment
 * has named its own database — see `isDemoSwitcherEnabled`.
 */
export const SWITCH_NOT_SEEDED =
  'That development account is not in this database. Run `npm run db:seed` to create the ' +
  'development accounts — see docs/development-seed.md.';

export const isDemoAccount = (email: string): boolean =>
  DEMO_ACCOUNTS.some((account) => account.email === email.trim().toLowerCase());

/** The published development password. The switcher verifies against it. */
export const DEVELOPMENT_PASSWORD = DEMO_PASSWORD;

/**
 * The password to verify, for whichever demonstration dataset is loaded.
 *
 * There are two, and they are not the same: the PostgreSQL seed gives its five
 * accounts the password published in `docs/development-seed.md`, while the
 * in-memory demonstration store gives EVERY seeded person one shared password,
 * stated on its own sign-in screen. The switcher performs the real sign-in
 * either way, so it has to present the right one.
 */
export const developmentPasswordFor = (backend: PersistenceBackend): string =>
  backend === 'demo' ? IN_MEMORY_DEMO_PASSWORD : DEMO_PASSWORD;

/**
 * Puts the five switcher accounts into the in-memory register.
 *
 * WHY THIS EXISTS: `npm run dev` with no `DATABASE_URL` runs the demonstration
 * store, whose people are EJE's fictional staff — not these five. Requiring a
 * PostgreSQL install before a developer can change role would defeat the point
 * of the switcher entirely, so the accounts are added to that register on
 * demand instead.
 *
 * They are ordinary `User` records, so a session for one of them is an ordinary
 * session and every authorization rule applies unchanged. Idempotent, and it
 * touches nothing that is already there.
 *
 * DEVELOPMENT AND THE IN-MEMORY STORE ONLY. Against PostgreSQL the accounts
 * come from `npm run db:seed` and this is never called — nothing here writes to
 * a database.
 */
let accountsEnsured = false;

export const ensureDemoAccounts = async (repos: RepositoryBundle): Promise<void> => {
  // Once per process. The in-memory register outlives the request, so redoing
  // this on every call was work that could never find anything to do.
  if (accountsEnsured) return;

  const existing = await repos.users.list();
  const known = new Set(existing.map((user) => user.email.toLowerCase()));

  for (const { user } of seedPeople) {
    if (known.has(user.email.toLowerCase())) continue;
    await repos.users.save(user);
  }

  accountsEnsured = true;
};

/** Lets a test start from an empty register. */
export const forgetDemoAccounts = (): void => {
  accountsEnsured = false;
};
