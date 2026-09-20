import 'server-only';
import type { IsoDateTime, UserId } from '@/domain';
import { generateSessionToken, hashSessionToken } from './tokens';
import type { AuthStore, SessionRecord } from './store';

/**
 * Server-side sessions.
 *
 * TWO CLOCKS, on purpose:
 *
 *  - IDLE (12 hours). Moved forward by activity, so a technician working a full
 *    day on site is never signed out mid-job card.
 *  - ABSOLUTE (30 days). Never extended. A tablet left in a van does not stay
 *    authenticated for ever because somebody opened the application once a
 *    week.
 *
 * Both are stored on the row rather than inferred, so changing the policy later
 * does not retroactively lengthen sessions that already exist.
 */
export const IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000;
export const ABSOLUTE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/** Only moved forward when it has drifted by more than this, to save a write per request. */
const TOUCH_THRESHOLD_MS = 60 * 1000;

const iso = (epochMs: number): IsoDateTime => new Date(epochMs).toISOString();

export interface IssuedSession {
  /** The raw token. Goes into the cookie and is never stored or logged. */
  readonly token: string;
  readonly id: string;
  readonly expiresAt: IsoDateTime;
}

export interface SessionContext {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export const issueSession = async (
  store: AuthStore,
  userId: UserId,
  now: Date,
  context: SessionContext,
): Promise<IssuedSession> => {
  const token = generateSessionToken();
  const id = crypto.randomUUID();
  const expiresAt = iso(now.getTime() + IDLE_TIMEOUT_MS);

  await store.createSession({
    id,
    userId,
    tokenHash: hashSessionToken(token),
    expiresAt,
    absoluteExpiresAt: iso(now.getTime() + ABSOLUTE_LIFETIME_MS),
    ip: context.ip,
    userAgent: context.userAgent,
  });

  return { token, id, expiresAt };
};

/** Why a session was not accepted. Never told to the client in this detail. */
export type SessionRefusal = 'missing' | 'revoked' | 'idle_expired' | 'expired';

export type SessionResolution =
  | { readonly ok: true; readonly session: SessionRecord }
  | { readonly ok: false; readonly reason: SessionRefusal };

/**
 * Resolves a token to a live session, and slides its idle expiry forward.
 *
 * Every check is made HERE rather than in the routes, because a route that
 * forgets one is a route that authenticates a revoked session.
 */
export const resolveSession = async (
  store: AuthStore,
  token: string,
  now: Date,
): Promise<SessionResolution> => {
  const session = await store.findSessionByTokenHash(hashSessionToken(token));
  if (session === null) return { ok: false, reason: 'missing' };
  if (session.revokedAt !== null) return { ok: false, reason: 'revoked' };

  const absolute = Date.parse(session.absoluteExpiresAt);
  if (Number.isFinite(absolute) && now.getTime() >= absolute) {
    return { ok: false, reason: 'expired' };
  }

  const idle = Date.parse(session.expiresAt);
  if (Number.isFinite(idle) && now.getTime() >= idle) {
    return { ok: false, reason: 'idle_expired' };
  }

  /*
   * The slide, capped by the absolute ceiling.
   *
   * Written only when it has actually moved by a minute or more: every request
   * would otherwise be a write, and the sliding window does not need
   * second-level precision to do its job.
   */
  const next = Math.min(now.getTime() + IDLE_TIMEOUT_MS, absolute);
  if (next - idle >= TOUCH_THRESHOLD_MS) {
    await store.touchSession(session.id, iso(now.getTime()), iso(next));
  }

  return { ok: true, session };
};
