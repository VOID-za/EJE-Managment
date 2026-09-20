import 'server-only';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Session tokens.
 *
 * OPAQUE AND RANDOM, not a JWT. Disabling an account has to take effect on the
 * next request rather than at the next expiry, and a signed token that carries
 * its own claims cannot be withdrawn — the server would have to keep a
 * revocation list anyway, at which point the token may as well be a key into
 * it. See `sessions.ts`.
 */

/** 256 bits from the platform CSPRNG. */
const TOKEN_BYTES = 32;

export const generateSessionToken = (): string => randomBytes(TOKEN_BYTES).toString('base64url');

/**
 * What is stored. NEVER the token itself.
 *
 * SHA-256 rather than Argon2id, deliberately: the token is 256 bits of
 * uniformly random data, so there is no dictionary to slow down and no
 * low-entropy secret to protect. What the hash buys is that a database leak
 * yields no usable session, and that is achieved either way — while a slow hash
 * on every single request would not be.
 */
export const hashSessionToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** Constant-time comparison, for anything compared against a stored digest. */
export const digestsMatch = (left: string, right: string): boolean => {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};
