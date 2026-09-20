import 'server-only';
import type { NextRequest } from 'next/server';
import { forbidden } from './errors';

/**
 * Cross-site request forgery.
 *
 * The API is same-origin with the application it serves, and authentication is
 * a cookie — which is precisely the combination CSRF exploits. Two mechanisms,
 * both of which must hold:
 *
 *  1. `SameSite=Lax` on the session cookie. The browser does not send it on a
 *     cross-site POST at all, so a form on somebody else's page arrives
 *     unauthenticated. This alone defeats the classic attack.
 *  2. THE CHECK BELOW, because (1) is a browser promise and browsers have had
 *     bugs. Every state-changing request must present a `Sec-Fetch-Site` of
 *     `same-origin` (or `none`, which is a user typing the URL), or an `Origin`
 *     that matches the host it was sent to.
 *
 * WHY NO TOKEN. A synchroniser token would add a third mechanism and a great
 * deal of plumbing — a token endpoint, a store, rotation, a second thing for
 * every client call to get right — to defend an attack that (1) and (2) already
 * close for every browser this application supports. Chrome on the RugKing
 * tablet has sent `Sec-Fetch-Site` since 2019. If EJE ever needs to accept
 * cross-origin credentialed requests, that decision brings the token with it;
 * until then this is the simplest thing that is actually correct.
 *
 * Reads are not checked: a cross-site GET cannot change anything, and the
 * response is unreadable to the attacker under the same-origin policy.
 */
const SAFE_SITES = new Set(['same-origin', 'none']);

export const assertSameOrigin = (request: NextRequest): void => {
  const site = request.headers.get('sec-fetch-site');
  if (site !== null) {
    if (SAFE_SITES.has(site)) return;
    throw forbidden('This request did not come from the EJE application.');
  }

  /*
   * No `Sec-Fetch-Site` at all: an older client, or a non-browser caller.
   *
   * Fall back to comparing Origin against the host the request was actually
   * sent to. A missing Origin on a same-origin fetch is normal for some
   * clients, so its absence is not by itself an attack — but a PRESENT Origin
   * that disagrees with the Host is, and that is the case worth refusing.
   */
  const origin = request.headers.get('origin');
  if (origin === null) return;

  const host = request.headers.get('host');
  if (host === null) throw forbidden('This request did not come from the EJE application.');

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw forbidden('This request did not come from the EJE application.');
  }

  if (originHost !== host) {
    throw forbidden('This request did not come from the EJE application.');
  }
};
