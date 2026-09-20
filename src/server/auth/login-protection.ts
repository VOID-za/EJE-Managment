import 'server-only';
import type { CredentialRecord } from './store';

/**
 * Repeated failed sign-ins.
 *
 * FIVE ATTEMPTS, FIFTEEN MINUTES — the figure the architecture phase settled
 * on. Counted per ACCOUNT rather than per address, because an account is what
 * an attacker is actually trying to reach and an address is trivially changed.
 *
 * A locked account is told exactly what an account with a wrong password is
 * told. Saying "this account is locked" confirms the account exists, which is
 * the one thing the login response must never do; the office can see the lock
 * on the user record, where it belongs.
 */
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;

export const isLockedOut = (credentials: CredentialRecord, now: Date): boolean => {
  if (credentials.lockedUntil === null) return false;
  const until = Date.parse(credentials.lockedUntil);
  return Number.isFinite(until) && now.getTime() < until;
};

/**
 * When the account should be locked until, after this failure.
 *
 * Null while there are attempts left. The count passed in is the one BEFORE
 * this failure, so the fifth consecutive failure is what locks it.
 */
export const lockoutAfterFailure = (
  credentials: CredentialRecord,
  now: Date,
): string | null => {
  const failures = credentials.failedLoginCount + 1;
  return failures >= MAX_FAILED_ATTEMPTS
    ? new Date(now.getTime() + LOCKOUT_MS).toISOString()
    : null;
};
