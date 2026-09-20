import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { userFullName } from '@/domain';
import { toSafeUser } from '@/server/api/actor';
import { assertSameOrigin } from '@/server/api/csrf';
import { ApiError, errorResponse, logUnexpected, toApiError } from '@/server/api/errors';
import { parseWith } from '@/server/api/handler';
import { clientAddress, enforce } from '@/server/api/rate-limit';
import { recordSecurityEvent } from '@/server/api/security-audit';
import { setSessionCookie } from '@/server/auth/cookies';
import {
  isLockedOut,
  lockoutAfterFailure,
  MAX_FAILED_ATTEMPTS,
} from '@/server/auth/login-protection';
import { verifyAgainstDummy, verifyPassword } from '@/server/auth/passwords';
import { issueSession } from '@/server/auth/sessions';
import { getServerRuntime } from '@/server/runtime';

/**
 * Signing in.
 *
 * THE RESPONSE IS THE SAME FOR EVERY FAILURE. Wrong password, unknown address,
 * disabled account, locked-out account — one sentence, one status, and the same
 * amount of work done before answering. Anything else is a way to ask the
 * server which of EJE's email addresses are real, one guess at a time.
 *
 * The timing is levelled by `verifyAgainstDummy`: an unknown address is charged
 * a full Argon2id verification against a hash of something nobody knows, so the
 * two paths take the same tens of milliseconds.
 *
 * Two independent protections, doing different jobs:
 *
 *  - THE PER-ACCOUNT LOCKOUT (five attempts, fifteen minutes) is persisted and
 *    protects the ACCOUNT. It survives a restart and a second server.
 *  - THE PER-ADDRESS RATE LIMIT protects the SERVER from being made to perform
 *    thousands of deliberately expensive hashes. It is in memory and says so.
 */
const LOGIN_ATTEMPTS_PER_WINDOW = 20;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;

/**
 * What the limit is counted against.
 *
 * The client's address where there is one — behind Caddy, `X-Forwarded-For`
 * names it. WHERE THERE IS NOT, EVERY REQUEST WOULD OTHERWISE SHARE ONE
 * BUCKET, and one person mistyping their password twenty times would lock the
 * whole business out of signing in. That is a worse failure than the one the
 * limit exists to prevent, so with no usable address the count is kept per
 * ADDRESS BOOK ENTRY instead: the protection still applies, and it cannot be
 * turned into a denial of service against everybody else.
 */
const limitKey = (address: string, email: string): string =>
  address === 'unknown' ? `login:email:${email.toLowerCase()}` : `login:ip:${address}`;

const schema = z.object({
  email: z.string().trim().min(1, 'Enter your email address.').max(320),
  password: z.string().min(1, 'Enter your password.').max(1024),
});

/** One sentence for every way this can fail. */
const REFUSED = new ApiError('unauthenticated', 'That email address and password do not match.');

export const POST = async (request: NextRequest): Promise<NextResponse> => {
  try {
    assertSameOrigin(request);

    /*
     * Validated BEFORE the limit is counted.
     *
     * Parsing a small JSON body is cheap and tells nobody anything; what must
     * not happen before the count is the Argon2id verification, and that is
     * still below.
     */
    const input = parseWith(schema, await request.json().catch(() => ({})));

    const address = clientAddress(request.headers);
    enforce(limitKey(address, input.email), LOGIN_ATTEMPTS_PER_WINDOW, LOGIN_WINDOW_MS);

    const runtime = getServerRuntime();
    const now = new Date();

    const credentials = await runtime.auth.findCredentialsByEmail(input.email);

    if (credentials === null) {
      await verifyAgainstDummy(input.password);
      await runtime.write(({ repos }) =>
        recordSecurityEvent(repos, {
          type: 'user_sign_in_failed',
          summary: 'Sign-in refused',
          detail: `No account matches ${input.email}.`,
          actorId: null,
          occurredAt: now.toISOString(),
        }),
      );
      throw REFUSED;
    }

    /*
     * A locked account is charged the same work and told the same thing.
     *
     * Telling the client "this account is locked" would confirm the account
     * exists and hand an attacker a progress indicator. The office can see the
     * lock on the user record, which is where it is useful.
     */
    if (isLockedOut(credentials, now)) {
      await verifyAgainstDummy(input.password);
      throw REFUSED;
    }

    const matches =
      credentials.passwordHash !== null &&
      (await verifyPassword(credentials.passwordHash, input.password));

    if (!matches || !credentials.active) {
      const lockUntil = credentials.active ? lockoutAfterFailure(credentials, now) : null;
      await runtime.auth.recordFailedLogin(credentials.userId, lockUntil);

      await runtime.write(({ repos }) =>
        recordSecurityEvent(repos, {
          type: lockUntil === null ? 'user_sign_in_failed' : 'user_locked_out',
          summary: lockUntil === null ? 'Sign-in refused' : 'Account locked',
          detail:
            lockUntil === null
              ? `A sign-in for ${credentials.email} was refused.`
              : `${MAX_FAILED_ATTEMPTS} failed attempts for ${credentials.email}. Locked until ${lockUntil}.`,
          actorId: credentials.userId,
          occurredAt: now.toISOString(),
        }),
      );
      throw REFUSED;
    }

    const user = await runtime.read(({ repos }) => repos.users.findById(credentials.userId));
    if (user === null || !user.active) throw REFUSED;

    await runtime.auth.recordSuccessfulLogin(credentials.userId, now.toISOString());

    const session = await issueSession(runtime.auth, user.id, now, {
      ip: clientAddress(request.headers) === 'unknown' ? null : clientAddress(request.headers),
      userAgent: request.headers.get('user-agent'),
    });

    await runtime.write(({ repos }) =>
      recordSecurityEvent(repos, {
        type: 'user_signed_in',
        summary: `Signed in: ${userFullName(user)}`,
        detail: `${user.email} signed in.`,
        actorId: user.id,
        occurredAt: now.toISOString(),
      }),
    );

    // The token goes into the cookie and NOWHERE ELSE — not the body, not a
    // header the browser can read, not the log.
    const response = NextResponse.json({ data: { user: toSafeUser(user) } });
    setSessionCookie(response, session.token);
    return response;
  } catch (cause) {
    logUnexpected('auth.login', cause);
    return errorResponse(toApiError(cause));
  }
};
