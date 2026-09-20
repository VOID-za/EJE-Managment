import 'server-only';
import type { NextRequest, NextResponse } from 'next/server';
import { IDLE_TIMEOUT_MS } from './sessions';

/**
 * The session cookie.
 *
 * `__Host-` is a prefix the BROWSER enforces: it will only store the cookie if
 * it is Secure, has no Domain and has Path=/. That makes it impossible for a
 * sibling subdomain — or a network attacker who can forge a response from one —
 * to set or overwrite EJE's session cookie. The guarantee is worth the
 * constraint, which is that the application must be served over HTTPS.
 * `localhost` counts as a secure origin, so development and the browser suites
 * are unaffected.
 *
 * HttpOnly: no script can read it, so an injected script cannot exfiltrate a
 * session. SameSite=Lax: the cookie is not sent on a cross-site POST, which is
 * the first half of the CSRF defence (see `src/server/api/csrf.ts`).
 */
export const SESSION_COOKIE = '__Host-eje_session';

export const readSessionToken = (request: NextRequest): string | null =>
  request.cookies.get(SESSION_COOKIE)?.value ?? null;

/**
 * Attaches the session cookie.
 *
 * `maxAge` matches the IDLE timeout rather than the absolute one: a browser
 * that has not been used for twelve hours drops the cookie by itself, and the
 * server refuses the session anyway. The two agreeing is what stops a stale
 * cookie being sent on every request for a month.
 */
export const setSessionCookie = (response: NextResponse, token: string): void => {
  response.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(IDLE_TIMEOUT_MS / 1000),
  });
};

/** Clears it, with the same attributes — a cookie is only replaced by its match. */
export const clearSessionCookie = (response: NextResponse): void => {
  response.cookies.set({
    name: SESSION_COOKIE,
    value: '',
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
};
