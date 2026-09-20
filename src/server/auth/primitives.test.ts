import { describe, expect, it } from 'vitest';
import { WorkflowError } from '@/application/errors';
import { ConcurrencyError } from '@/data/postgres/transaction';
import { ApiError, toApiError } from '@/server/api/errors';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './passwords';
import { digestsMatch, generateSessionToken, hashSessionToken } from './tokens';
import { ABSOLUTE_LIFETIME_MS, IDLE_TIMEOUT_MS } from './sessions';
import { LOCKOUT_MS, MAX_FAILED_ATTEMPTS } from './login-protection';
import { SESSION_COOKIE } from './cookies';

describe('password hashing', () => {
  it('produces an Argon2id hash with the agreed parameters', async () => {
    const encoded = await hashPassword('a-real-password');

    // The encoded hash carries its own parameters, which is what lets them be
    // raised later without invalidating anybody's credentials.
    expect(encoded.startsWith('$argon2id$')).toBe(true);
    expect(encoded).toContain('m=19456');
    expect(encoded).toContain('t=2');
    expect(encoded).toContain('p=1');
  });

  it('never produces the same hash twice for the same password', async () => {
    const [first, second] = await Promise.all([
      hashPassword('a-real-password'),
      hashPassword('a-real-password'),
    ]);

    expect(first).not.toBe(second);
    expect(await verifyPassword(first, 'a-real-password')).toBe(true);
    expect(await verifyPassword(second, 'a-real-password')).toBe(true);
  });

  it('refuses the wrong password', async () => {
    const encoded = await hashPassword('a-real-password');
    expect(await verifyPassword(encoded, 'a-real-passwore')).toBe(false);
    expect(await verifyPassword(encoded, '')).toBe(false);
  });

  it('treats a corrupt stored hash as a refusal rather than an exception', async () => {
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
    expect(await verifyPassword('', 'anything')).toBe(false);
  });

  it('charges an unknown account a real verification', async () => {
    const started = Date.now();
    expect(await verifyAgainstDummy('anything')).toBe(false);
    // Argon2id at these parameters is tens of milliseconds; the point is that
    // it is not zero, which is what an early return would be.
    expect(Date.now() - started).toBeGreaterThan(1);
  });
});

describe('session tokens', () => {
  it('carries at least 256 bits of randomness', () => {
    const token = generateSessionToken();
    // 32 bytes, base64url encoded and unpadded.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateSessionToken()));
    expect(tokens.size).toBe(500);
  });

  it('is stored as a SHA-256 digest and nothing else', () => {
    const token = generateSessionToken();
    const digest = hashSessionToken(token);

    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(digest).not.toContain(token);
    expect(hashSessionToken(token)).toBe(digest);
    expect(hashSessionToken(generateSessionToken())).not.toBe(digest);
  });

  it('compares digests without leaking their contents through timing', () => {
    const digest = hashSessionToken('token');
    expect(digestsMatch(digest, digest)).toBe(true);
    expect(digestsMatch(digest, hashSessionToken('other'))).toBe(false);
    expect(digestsMatch(digest, 'short')).toBe(false);
  });
});

describe('the agreed policy', () => {
  it('is twelve idle hours and thirty absolute days', () => {
    expect(IDLE_TIMEOUT_MS).toBe(12 * 60 * 60 * 1000);
    expect(ABSOLUTE_LIFETIME_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(ABSOLUTE_LIFETIME_MS).toBeGreaterThan(IDLE_TIMEOUT_MS);
  });

  it('is five attempts and fifteen minutes', () => {
    expect(MAX_FAILED_ATTEMPTS).toBe(5);
    expect(LOCKOUT_MS).toBe(15 * 60 * 1000);
  });

  it('names the cookie with the __Host- prefix', () => {
    expect(SESSION_COOKIE).toBe('__Host-eje_session');
    expect(SESSION_COOKIE.startsWith('__Host-')).toBe(true);
  });
});

describe('the error boundary', () => {
  it('keeps a workflow refusal, with its violations', () => {
    const refused = toApiError(
      new WorkflowError('That cannot be submitted yet.', [
        { code: 'no_labour', message: 'Capture at least one labour line.' },
      ]),
    );

    expect(refused.code).toBe('workflow_refused');
    expect(refused.violations).toHaveLength(1);
  });

  it('reads an authorization violation as forbidden', () => {
    const refused = toApiError(
      new WorkflowError('You may not do that.', [
        { code: 'not_permitted', message: 'Your role does not allow this.' },
      ]),
    );

    expect(refused.code).toBe('forbidden');
  });

  it('reads a stale version as a conflict rather than an overwrite', () => {
    const conflict = toApiError(new ConcurrencyError('jobs', 'job-1', 3));

    expect(conflict.code).toBe('version_conflict');
    expect(conflict.violations[0]?.code).toBe('version_conflict');
  });

  it('says nothing at all about an unexpected failure', () => {
    const cause = new Error(
      'select * from jobs where id = $1 failed: connection to postgres://eje:secret@db:5432 refused',
    );
    const reported = toApiError(cause);

    expect(reported.code).toBe('internal_error');
    expect(reported.message).toBe('Something went wrong. Please try again.');
    expect(reported.message).not.toContain('postgres');
    expect(reported.message).not.toContain('select');
  });

  it('passes an ApiError through unchanged', () => {
    const original = new ApiError('not_found', 'That job does not exist.');
    expect(toApiError(original)).toBe(original);
  });
});
