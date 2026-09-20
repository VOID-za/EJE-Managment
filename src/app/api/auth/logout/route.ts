import { NextResponse, type NextRequest } from 'next/server';
import { userFullName } from '@/domain';
import { assertSameOrigin } from '@/server/api/csrf';
import { errorResponse, logUnexpected, toApiError } from '@/server/api/errors';
import { recordSecurityEvent } from '@/server/api/security-audit';
import { clearSessionCookie, readSessionToken } from '@/server/auth/cookies';
import { resolveSession } from '@/server/auth/sessions';
import { getServerRuntime } from '@/server/runtime';

/**
 * Signing out.
 *
 * SAFE TO CALL WHEN ALREADY SIGNED OUT, and deliberately so: a client whose
 * session has just expired still has a stale cookie, and answering its logout
 * with 401 would leave that cookie in place. There is nothing to protect here —
 * ending your own session is not a privileged act — so the answer is always
 * "you are signed out", and the cookie is always cleared.
 *
 * The session is REVOKED server-side, not merely forgotten by the browser. A
 * token that has been sent over the wire is a token that may have been copied.
 */
export const POST = async (request: NextRequest): Promise<NextResponse> => {
  try {
    assertSameOrigin(request);

    const response = NextResponse.json({ data: { signedOut: true } });
    clearSessionCookie(response);

    const token = readSessionToken(request);
    if (token === null) return response;

    const runtime = getServerRuntime();
    const now = new Date();
    const resolution = await resolveSession(runtime.auth, token, now);
    if (!resolution.ok) return response;

    await runtime.auth.revokeSession(resolution.session.id, now.toISOString(), 'signed out');

    const user = await runtime.read(({ repos }) => repos.users.findById(resolution.session.userId));
    if (user !== null) {
      await runtime.write(({ repos }) =>
        recordSecurityEvent(repos, {
          type: 'user_signed_out',
          summary: `Signed out: ${userFullName(user)}`,
          detail: 'The session was ended and can no longer be used.',
          actorId: user.id,
          occurredAt: now.toISOString(),
        }),
      );
    }

    return response;
  } catch (cause) {
    logUnexpected('auth.logout', cause);
    return errorResponse(toApiError(cause));
  }
};
