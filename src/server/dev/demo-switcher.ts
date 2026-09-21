import 'server-only';
import type { PersistenceBackend } from '@/data/backend';
import type { RepositoryBundle } from '@/data/repositories';
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
 * THREE THINGS KEEP IT OUT OF PRODUCTION, and all three must hold:
 *
 *  1. `NODE_ENV=production` switches it off completely. The route answers 404 —
 *     not "refused", because in production the endpoint genuinely does not
 *     exist. `next build` and `next start` set that variable, so a production
 *     deployment has no switcher even before anything is configured.
 *  2. The email must be one of the five accounts the development seed creates.
 *     A name is not enough: the list is read from the seed itself.
 *  3. The account's password must be the one published in
 *     `docs/development-seed.md`. An account with a real password cannot be
 *     switched into, so even a misconfigured deployment holding real people
 *     would hand this nothing.
 */
export const isDemoSwitcherEnabled = (
  env: { readonly NODE_ENV?: string | undefined } = process.env,
): boolean => (env.NODE_ENV ?? '').toLowerCase() !== 'production';

/** The accounts it may switch into, read from the seed rather than restated. */
export const DEMO_ACCOUNTS = seedPeople.map(({ user }) => ({
  email: user.email.toLowerCase(),
  firstName: user.firstName,
  lastName: user.lastName,
  role: user.role,
}));

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
export const ensureDemoAccounts = async (repos: RepositoryBundle): Promise<void> => {
  const existing = await repos.users.list();
  const known = new Set(existing.map((user) => user.email.toLowerCase()));

  for (const { user } of seedPeople) {
    if (known.has(user.email.toLowerCase())) continue;
    await repos.users.save(user);
  }
};
