import 'server-only';
import type { NextRequest } from 'next/server';
import type { User } from '@/domain';
import { readSessionToken } from '@/server/auth/cookies';
import { resolveSession } from '@/server/auth/sessions';
import { getServerRuntime } from '@/server/runtime';
import { unauthenticated } from './errors';

/**
 * Who is making this request.
 *
 * THE SERVER DECIDES. There is no path from a request body, a query parameter
 * or a header to the identity used here — only from the session cookie, which
 * the browser cannot read and cannot forge. A body carrying `actorId` is
 * ignored by construction, because nothing in this function looks at the body.
 *
 * Every check lives here rather than in the routes, so a route cannot
 * accidentally accept a revoked session by forgetting one of them:
 *
 *   cookie → session exists → not revoked → not expired (idle and absolute)
 *          → user exists → user is active → actor
 *
 * A DISABLED ACCOUNT FAILS AT THE NEXT REQUEST. Disabling revokes the sessions
 * (`user-operations`), and this re-checks `active` anyway — two mechanisms,
 * because a technician who has been let go must not keep a working tablet.
 */
export interface AuthenticatedActor {
  readonly user: User;
  readonly sessionId: string;
}

export const requireAuthenticatedActor = async (
  request: NextRequest,
): Promise<AuthenticatedActor> => {
  const token = readSessionToken(request);
  if (token === null) throw unauthenticated();

  const runtime = getServerRuntime();
  const resolution = await resolveSession(runtime.auth, token, new Date());
  if (!resolution.ok) {
    /*
     * One message for every refusal.
     *
     * "Your session expired" and "your session was revoked" are different facts
     * about the server's state, and the client can do exactly the same thing
     * about both: sign in again.
     */
    throw unauthenticated('Your session has ended. Sign in again.');
  }

  const user = await runtime.read(({ repos }) => repos.users.findById(resolution.session.userId));
  if (user === null) throw unauthenticated('Your session has ended. Sign in again.');
  if (!user.active) throw unauthenticated('This account is no longer active.');

  return { user, sessionId: resolution.session.id };
};

/**
 * The user profile the browser is allowed to hold.
 *
 * An explicit projection rather than the whole row, so a column added to
 * `users` later — a password hash, a lockout, a reset token — cannot start
 * being served to a browser because somebody spread an object.
 */
export interface SafeUser {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly initials: string;
  readonly email: string;
  readonly mobile: string;
  readonly role: User['role'];
  readonly jobTitle: string;
  readonly active: boolean;
  readonly createdAt: string;
}

export const toSafeUser = (user: User): SafeUser => ({
  id: user.id,
  firstName: user.firstName,
  lastName: user.lastName,
  initials: user.initials,
  email: user.email,
  mobile: user.mobile,
  role: user.role,
  jobTitle: user.jobTitle,
  active: user.active,
  createdAt: user.createdAt,
});
