import 'server-only';
import { rateLimited } from './errors';

/**
 * Rate limiting, for one process.
 *
 * THIS IS AN IN-MEMORY LIMITER AND IT IS NOT DISTRIBUTED. It counts attempts in
 * the memory of the process that served them. That is honest for the intended
 * deployment — one VPS, one Node process behind Caddy — and it is wrong the
 * moment there is a second instance, because each would allow the full budget.
 *
 * It is also lost on restart, which means a deploy resets everybody's counters.
 * For login that is acceptable: the per-account lockout in
 * `login-protection.ts` is PERSISTED, and it is the defence that actually
 * protects an account. This limiter protects the SERVER — from somebody making
 * ten thousand Argon2id verifications happen — which is a different job.
 *
 * The interface is deliberately the one a shared store would satisfy, so moving
 * to Redis later is a change to this file and nothing else. Redis is not being
 * added now: a single VPS does not need it, and adding it would be a second
 * thing to run, monitor and back up for no gain.
 */
export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

/** Keeps the map from growing without bound on a long-running process. */
const sweep = (now: number): void => {
  if (windows.size < 1024) return;
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }
};

export const consume = (
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): RateLimitDecision => {
  sweep(now);
  const existing = windows.get(key);

  if (existing === undefined || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  existing.count += 1;
  if (existing.count > limit) {
    return { allowed: false, retryAfterSeconds: (existing.resetAt - now) / 1000 };
  }
  return { allowed: true, retryAfterSeconds: 0 };
};

/**
 * Whether this key is already over budget, WITHOUT spending any of it.
 *
 * For a caller that only wants to charge for the attempts worth counting —
 * see `record`. Splitting the question from the charge is what lets the login
 * route refuse a flood without counting the people who got their password
 * right.
 */
export const check = (
  key: string,
  limit: number,
  now: number = Date.now(),
): RateLimitDecision => {
  const existing = windows.get(key);
  if (existing === undefined || existing.resetAt <= now) {
    return { allowed: true, retryAfterSeconds: 0 };
  }
  return existing.count >= limit
    ? { allowed: false, retryAfterSeconds: (existing.resetAt - now) / 1000 }
    : { allowed: true, retryAfterSeconds: 0 };
};

/** Charges one attempt against the key. */
export const record = (key: string, windowMs: number, now: number = Date.now()): void => {
  sweep(now);
  const existing = windows.get(key);
  if (existing === undefined || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  existing.count += 1;
};

const refuse = (decision: RateLimitDecision): void => {
  if (decision.allowed) return;
  throw rateLimited('Too many attempts. Wait a moment and try again.', decision.retryAfterSeconds);
};

export const enforce = (key: string, limit: number, windowMs: number): void => {
  refuse(consume(key, limit, windowMs));
};

/** Refuses when the key is over budget, and spends nothing when it is not. */
export const enforceWithoutCharging = (key: string, limit: number): void => {
  refuse(check(key, limit));
};

/** For tests, which must not inherit another test's counters. */
export const resetRateLimits = (): void => {
  windows.clear();
};

/**
 * Who is being limited.
 *
 * The proxy's forwarded address where there is one, because behind Caddy every
 * request appears to come from the loopback. Only the FIRST entry is used: the
 * rest of an `X-Forwarded-For` chain is whatever the client chose to send.
 */
export const clientAddress = (headers: Headers): string => {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded !== null && forwarded.length > 0) {
    const first = forwarded.split(',')[0]?.trim();
    if (first !== undefined && first.length > 0) return first;
  }
  return headers.get('x-real-ip') ?? 'unknown';
};
