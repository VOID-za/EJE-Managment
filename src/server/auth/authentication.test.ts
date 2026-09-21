import { beforeEach, describe, expect, it } from 'vitest';
import {
  ApiTestClient,
  DEMO_PASSWORD,
  DEMO_USERS,
  signedInAs,
  startTestServer,
} from '@/test/api-harness';
import { SESSION_COOKIE } from './cookies';
import { LOCKOUT_MS, MAX_FAILED_ATTEMPTS } from './login-protection';
import { hashSessionToken } from './tokens';
import { getServerRuntime } from '@/server/runtime';

/**
 * Signing in, over the real login route.
 *
 * These are not tests of a helper: every case here goes through the route the
 * browser posts to, with the real Argon2id verification, the real lockout
 * counter and the real cookie.
 */
describe('POST /api/auth/login', () => {
  beforeEach(() => {
    startTestServer();
  });

  it('accepts a correct email and password', async () => {
    const client = new ApiTestClient();
    const response = await client.signIn(DEMO_USERS.master, DEMO_PASSWORD);

    expect(response.status).toBe(200);
    expect((response.data as { user: { email: string } }).user.email).toBe(DEMO_USERS.master);
  });

  it('sets a __Host- session cookie that is HttpOnly, Secure, SameSite=Lax and Path=/', async () => {
    const client = new ApiTestClient();
    const response = await client.signIn(DEMO_USERS.master, DEMO_PASSWORD);

    const cookie = response.headers
      .getSetCookie()
      .find((entry) => entry.startsWith(`${SESSION_COOKIE}=`));

    expect(cookie).toBeDefined();
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=lax');
    expect(cookie).toContain('Path=/');
    // `__Host-` is only honoured by the browser when there is NO Domain.
    expect(cookie?.toLowerCase()).not.toContain('domain=');
  });

  it('creates a server-side session whose token is stored only as a SHA-256 digest', async () => {
    const client = new ApiTestClient();
    await client.signIn(DEMO_USERS.master, DEMO_PASSWORD);

    const token = client.token;
    expect(token).not.toBeNull();

    const store = getServerRuntime().auth;
    // The digest finds it; the raw token, used as a key, does not exist.
    expect(await store.findSessionByTokenHash(hashSessionToken(token ?? ''))).not.toBeNull();
    expect(await store.findSessionByTokenHash(token ?? '')).toBeNull();
  });

  it('never returns a password hash or a session token in the body', async () => {
    const client = new ApiTestClient();
    const response = await client.signIn(DEMO_USERS.master, DEMO_PASSWORD);

    const body = JSON.stringify(response.raw);
    expect(body).not.toContain('$argon2');
    expect(body).not.toContain('passwordHash');
    expect(body).not.toContain(client.token ?? 'no-token-issued');
  });

  it('refuses a wrong password', async () => {
    const client = new ApiTestClient();
    const response = await client.signIn(DEMO_USERS.master, 'not-the-password');

    expect(response.status).toBe(401);
    expect(response.error?.code).toBe('unauthenticated');
    expect(client.token).toBeNull();
  });

  it('answers an unknown address exactly as it answers a wrong password', async () => {
    const unknown = await new ApiTestClient().signIn('nobody@eje-demo.co.za', DEMO_PASSWORD);
    const wrong = await new ApiTestClient().signIn(DEMO_USERS.master, 'not-the-password');

    expect(unknown.status).toBe(wrong.status);
    expect(unknown.error?.message).toBe(wrong.error?.message);
    // Nothing in the answer says whether the account exists.
    expect(unknown.error?.message).not.toContain('nobody@eje-demo.co.za');
  });

  it('refuses a disabled account, and says no more than it says to anybody else', async () => {
    const disabled = await new ApiTestClient().signIn(DEMO_USERS.disabled, DEMO_PASSWORD);
    const wrong = await new ApiTestClient().signIn(DEMO_USERS.master, 'not-the-password');

    expect(disabled.status).toBe(401);
    expect(disabled.error?.message).toBe(wrong.error?.message);
  });

  it('locks the account after five failures, and refuses the correct password while locked', async () => {
    const client = new ApiTestClient();
    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      const response = await client.signIn(DEMO_USERS.coordinator, 'wrong');
      expect(response.status).toBe(401);
    }

    const locked = await client.signIn(DEMO_USERS.coordinator, DEMO_PASSWORD);
    expect(locked.status).toBe(401);
    expect(client.token).toBeNull();
    // The lockout is not disclosed — it reads exactly like a wrong password.
    expect(locked.error?.message).toBe('That email address and password do not match.');
  });

  it('does not lock other accounts when one is locked', async () => {
    const attacker = new ApiTestClient();
    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await attacker.signIn(DEMO_USERS.coordinator, 'wrong');
    }

    const other = await new ApiTestClient().signIn(DEMO_USERS.master, DEMO_PASSWORD);
    expect(other.status).toBe(200);
  });

  it('accepts the correct password once the lockout has elapsed', async () => {
    const client = new ApiTestClient();
    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await client.signIn(DEMO_USERS.coordinator, 'wrong');
    }
    expect((await client.signIn(DEMO_USERS.coordinator, DEMO_PASSWORD)).status).toBe(401);

    // Fifteen minutes later. The store keeps the moment, not a countdown, so
    // moving the clock forward is the whole of the passage of time.
    const store = getServerRuntime().auth;
    const credentials = await store.findCredentialsByEmail(DEMO_USERS.coordinator);
    expect(credentials?.lockedUntil).not.toBeNull();
    const expired = new Date(Date.now() - 1_000).toISOString();
    await store.recordFailedLogin(credentials?.userId ?? ('' as never), expired);

    const after = await client.signIn(DEMO_USERS.coordinator, DEMO_PASSWORD);
    expect(after.status).toBe(200);
    expect(LOCKOUT_MS).toBe(15 * 60 * 1000);
  });

  it('rejects a malformed body without disclosing anything', async () => {
    const response = await new ApiTestClient().post('/api/auth/login', { email: '' });

    expect(response.status).toBe(400);
    expect(response.error?.code).toBe('validation_failed');
  });

  it('refuses a cross-site sign-in', async () => {
    const response = await new ApiTestClient().post(
      '/api/auth/login',
      { email: DEMO_USERS.master, password: DEMO_PASSWORD },
      { crossSite: true },
    );

    expect(response.status).toBe(403);
  });

  it('rate limits repeated attempts from one address', async () => {
    const client = new ApiTestClient();
    let limited = 0;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await client.send('POST', '/api/auth/login', {
        body: { email: `someone-${attempt}@eje-demo.co.za`, password: 'wrong' },
        headers: { 'x-forwarded-for': '198.51.100.7' },
      });
      if (response.status === 429) {
        limited += 1;
        expect(response.headers.get('Retry-After')).not.toBeNull();
      }
    }
    expect(limited).toBeGreaterThan(0);
  });

  it('does not count a sign-in that succeeds', async () => {
    /*
     * The flood this limit exists to stop is made of WRONG passwords. Counting
     * the right ones refuses an office that switches between accounts during a
     * review, which is the system working against the people it is for.
     */
    const client = new ApiTestClient();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await client.signIn(DEMO_USERS.master, DEMO_PASSWORD);
      expect(response.status, `attempt ${attempt + 1}`).toBe(200);
      await client.post('/api/auth/logout');
    }
  });

  it('still refuses a flood of wrong passwords, and lets a genuine one through after', async () => {
    const attacker = new ApiTestClient();
    let refused = 0;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if ((await attacker.signIn(DEMO_USERS.coordinator, 'wrong')).status === 429) refused += 1;
    }
    expect(refused).toBeGreaterThan(0);

    // Somebody else's correct password is unaffected.
    expect((await new ApiTestClient().signIn(DEMO_USERS.master, DEMO_PASSWORD)).status).toBe(200);
  });

  it('does not let one address rate limit a different one', async () => {
    const attacker = new ApiTestClient();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await attacker.send('POST', '/api/auth/login', {
        body: { email: `someone-${attempt}@eje-demo.co.za`, password: 'wrong' },
        headers: { 'x-forwarded-for': '198.51.100.7' },
      });
    }

    const elsewhere = await new ApiTestClient().send('POST', '/api/auth/login', {
      body: { email: DEMO_USERS.master, password: DEMO_PASSWORD },
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });
    expect(elsewhere.status).toBe(200);
  });

  it('counts per account when the deployment gives no client address', async () => {
    /*
     * WITHOUT THIS, ONE PERSON MISTYPING LOCKS EVERYBODY OUT.
     *
     * Served with no proxy header, every request looks like the same client, so
     * a single bucket would be a denial of service against the whole business.
     */
    const client = new ApiTestClient();
    let limited = 0;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const response = await client.signIn(DEMO_USERS.technician, 'wrong');
      if (response.status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);

    // Somebody else is unaffected.
    const other = await new ApiTestClient().signIn(DEMO_USERS.master, DEMO_PASSWORD);
    expect(other.status).toBe(200);
  });
});

describe('the session', () => {
  beforeEach(() => {
    startTestServer();
  });

  it('authenticates subsequent requests from the cookie alone', async () => {
    const client = await signedInAs(DEMO_USERS.master);
    const me = await client.get('/api/auth/me');

    expect(me.status).toBe(200);
    expect((me.data as { user: { email: string } }).user.email).toBe(DEMO_USERS.master);
  });

  it('refuses a request with no cookie', async () => {
    const response = await new ApiTestClient().get('/api/auth/me');

    expect(response.status).toBe(401);
    expect(response.error?.code).toBe('unauthenticated');
  });

  it('refuses a forged token', async () => {
    const response = await new ApiTestClient().get('/api/auth/me', {
      token: 'a'.repeat(43),
    });

    expect(response.status).toBe(401);
  });

  it('refuses a revoked session, and logging out revokes it server-side', async () => {
    const client = await signedInAs(DEMO_USERS.master);
    const token = client.token;

    const out = await client.post('/api/auth/logout');
    expect(out.status).toBe(200);
    // The cookie is cleared...
    expect(client.token).toBeNull();
    // ...and the token itself no longer works, even when presented again.
    expect((await client.get('/api/auth/me', { token })).status).toBe(401);
  });

  it('answers a logout from a client that is already signed out', async () => {
    const response = await new ApiTestClient().post('/api/auth/logout');

    expect(response.status).toBe(200);
    expect((response.data as { signedOut: boolean }).signedOut).toBe(true);
  });

  it('refuses a session whose idle window has passed', async () => {
    const client = await signedInAs(DEMO_USERS.master);
    const store = getServerRuntime().auth;
    const session = await store.findSessionByTokenHash(hashSessionToken(client.token ?? ''));

    const past = new Date(Date.now() - 1_000).toISOString();
    await store.touchSession(session?.id ?? '', past, past);

    expect((await client.get('/api/auth/me')).status).toBe(401);
  });

  it('refuses a session whose absolute lifetime has passed, however recent the activity', async () => {
    const client = await signedInAs(DEMO_USERS.master);
    const store = getServerRuntime().auth;
    const hash = hashSessionToken(client.token ?? '');
    const session = await store.findSessionByTokenHash(hash);
    expect(session).not.toBeNull();

    // Rebuild the row with an absolute ceiling in the past but a fresh idle
    // window — the case a sliding expiry alone would keep alive for ever.
    await store.createSession({
      id: session?.id ?? '',
      userId: session?.userId ?? ('' as never),
      tokenHash: hash,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      absoluteExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      ip: null,
      userAgent: null,
    });

    expect((await client.get('/api/auth/me')).status).toBe(401);
  });

  it('slides the idle expiry forward on activity', async () => {
    const client = await signedInAs(DEMO_USERS.master);
    const store = getServerRuntime().auth;
    const hash = hashSessionToken(client.token ?? '');

    const before = await store.findSessionByTokenHash(hash);
    // Put the expiry far enough back that the one-minute write threshold is met.
    await store.touchSession(
      before?.id ?? '',
      new Date().toISOString(),
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    );
    const moved = await store.findSessionByTokenHash(hash);

    expect((await client.get('/api/auth/me')).status).toBe(200);
    const after = await store.findSessionByTokenHash(hash);
    expect(Date.parse(after?.expiresAt ?? '')).toBeGreaterThan(Date.parse(moved?.expiresAt ?? ''));
  });

  it('stops authenticating as soon as the account is disabled', async () => {
    const technician = await signedInAs(DEMO_USERS.otherTechnician);
    expect((await technician.get('/api/auth/me')).status).toBe(200);

    const master = await signedInAs(DEMO_USERS.master);
    const users = await master.get<{ users: readonly { id: string; email: string }[] }>(
      '/api/admin',
    );
    const target = users.data.users.find((user) => user.email === DEMO_USERS.otherTechnician);
    expect(target).toBeDefined();

    const disabled = await master.post(`/api/users/${target?.id ?? ''}/set_active`, {
      active: false,
    });
    expect(disabled.status).toBe(200);

    // Their sessions were revoked, and the user is inactive besides.
    expect((await technician.get('/api/auth/me')).status).toBe(401);
  });

  it('does not let a body decide who the session belongs to', async () => {
    const technician = await signedInAs(DEMO_USERS.technician);
    const master = await signedInAs(DEMO_USERS.master);
    const masterMe = await master.get<{ user: { id: string } }>('/api/auth/me');

    const me = await technician.send<{ user: { id: string; role: string } }>('GET', '/api/auth/me');
    expect(me.data.user.role).toBe('technician');
    expect(me.data.user.id).not.toBe(masterMe.data.user.id);
  });
});
