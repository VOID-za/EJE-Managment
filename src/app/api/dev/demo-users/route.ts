import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { userFullName } from '@/domain';
import { toSafeUser } from '@/server/api/actor';
import { assertSameOrigin } from '@/server/api/csrf';
import { errorResponse, logUnexpected, notFound, toApiError } from '@/server/api/errors';
import { parseWith } from '@/server/api/handler';
import { recordSecurityEvent } from '@/server/api/security-audit';
import { readSessionToken, setSessionCookie } from '@/server/auth/cookies';
import { verifyPassword } from '@/server/auth/passwords';
import { issueSession, resolveSession } from '@/server/auth/sessions';
import {
  DEMO_ACCOUNTS,
  developmentPasswordFor,
  ensureDemoAccounts,
  isDemoAccount,
  isDemoSwitcherEnabled,
} from '@/server/dev/demo-switcher';
import { getServerRuntime } from '@/server/runtime';

/**
 * Switching between the seeded development accounts.
 *
 * `GET` lists them so the control can be drawn. `POST` signs in as one.
 *
 * BOTH ANSWER 404 IN PRODUCTION. Not 403 — there is nothing to refuse, because
 * the endpoint does not exist there. See `src/server/dev/demo-switcher.ts` for
 * the three conditions that have to hold before it does anything at all.
 *
 * What `POST` does is the ORDINARY sign-in, performed on the server: find the
 * account, verify the published development password against its stored
 * Argon2id hash, revoke whatever session the browser is holding, and issue a
 * new one. No shortcut, no second kind of session, and no path a production
 * deployment can reach.
 */
const switchTo = z.object({ email: z.string().trim().min(1).max(320) }).strict();

/** One sentence, whatever went wrong. This is a development tool, not an oracle. */
const REFUSED = 'That development account cannot be switched into.';

/**
 * The development accounts, whenever the switcher exists at all.
 *
 * NOT filtered against the register. It was, briefly, so the control would not
 * appear on a database nobody had seeded — and the cost was that the control
 * vanished silently on `npm run dev`, which is the one place it is for. A
 * developer who cannot see it has no way to tell a missing feature from an
 * unseeded database.
 *
 * So the list is the five accounts, always, and a name that is not in this
 * database is refused by `POST` with a message that says to run the seed.
 * Telling somebody what to do beats hiding the control that would have told
 * them.
 */
export const GET = async (): Promise<NextResponse> => {
  try {
    if (!isDemoSwitcherEnabled()) throw notFound('Not found.');

    /*
     * On the in-memory demonstration store, put the five accounts there.
     *
     * That store is what `npm run dev` runs with no `DATABASE_URL`, and its
     * people are EJE's fictional staff rather than these five. Requiring a
     * PostgreSQL install before a developer can change role would defeat the
     * switcher entirely.
     */
    const runtime = getServerRuntime();
    if (runtime.backend === 'demo') {
      await runtime.write(({ repos }) => ensureDemoAccounts(repos));
    }

    return NextResponse.json({ data: { users: DEMO_ACCOUNTS } });
  } catch (cause) {
    logUnexpected('dev.demo-users', cause);
    return errorResponse(toApiError(cause));
  }
};

export const POST = async (request: NextRequest): Promise<NextResponse> => {
  try {
    if (!isDemoSwitcherEnabled()) throw notFound('Not found.');
    assertSameOrigin(request);

    const input = parseWith(switchTo, await request.json().catch(() => ({})));

    // Only the seeded development accounts, read from the seed itself.
    if (!isDemoAccount(input.email)) throw notFound(REFUSED);

    const runtime = getServerRuntime();
    const now = new Date();

    // The in-memory store's register is built on demand; see `GET`.
    if (runtime.backend === 'demo') {
      await runtime.write(({ repos }) => ensureDemoAccounts(repos));
    }

    const credentials = await runtime.auth.findCredentialsByEmail(input.email);
    if (credentials === null || !credentials.active) throw notFound(REFUSED);

    /*
     * THE REAL VERIFICATION, against the real hash.
     *
     * This is what makes the switcher safe rather than merely hidden: an
     * account whose password is not the published development one cannot be
     * switched into, however the environment is configured. Which password
     * that is depends on which demonstration dataset is loaded — the two are
     * not the same, and `developmentPasswordFor` is where that is decided.
     */
    const matches =
      credentials.passwordHash !== null &&
      (await verifyPassword(
        credentials.passwordHash,
        developmentPasswordFor(runtime.backend),
      ));
    if (!matches) throw notFound(REFUSED);

    const user = await runtime.read(({ repos }) => repos.users.findById(credentials.userId));
    if (user === null || !user.active) throw notFound(REFUSED);

    // The session being left is ended server-side, not merely replaced in the
    // browser — the same as signing out.
    const token = readSessionToken(request);
    if (token !== null) {
      const current = await resolveSession(runtime.auth, token, now);
      if (current.ok) {
        await runtime.auth.revokeSession(current.session.id, now.toISOString(), 'switched user');
      }
    }

    const session = await issueSession(runtime.auth, user.id, now, {
      ip: null,
      userAgent: request.headers.get('user-agent'),
    });

    await runtime.write(({ repos }) =>
      recordSecurityEvent(repos, {
        type: 'user_signed_in',
        summary: `Signed in: ${userFullName(user)}`,
        detail: `${user.email} signed in through the development user switcher.`,
        actorId: user.id,
        occurredAt: now.toISOString(),
      }),
    );

    const response = NextResponse.json({ data: { user: toSafeUser(user) } });
    setSessionCookie(response, session.token);
    return response;
  } catch (cause) {
    /*
     * A refused switch leaves the caller exactly as they were.
     *
     * The old session is revoked only AFTER every check has passed, so a
     * refusal here cannot sign somebody out of a session they still hold.
     */
    logUnexpected('dev.switch-user', cause);
    return errorResponse(toApiError(cause));
  }
};
