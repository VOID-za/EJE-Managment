import 'server-only';
import { DEMO_PASSWORD, seedPeople } from '@/db/seed/people';

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
