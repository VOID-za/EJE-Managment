import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as schema from '@/db/schema';
import { openTestDatabase, testDatabaseUrl, truncateAll } from '@/data/postgres/test-database';
import { seedBaseline, IDS } from '@/data/postgres/test-fixtures';
import { hashPassword } from '@/server/auth/hashing';
import { DEMO_ACCOUNTS, DEVELOPMENT_PASSWORD } from './demo-switcher';
import { ApiTestClient, startPostgresTestServer } from '@/test/api-harness';

/**
 * The switcher against a real database.
 *
 * `npm test` runs on the demonstration backend, whose people are not the
 * switcher's accounts — so what could not be proved there is proved here: that
 * clicking a name produces a genuine session for that person, and that an
 * account whose password is NOT the published development one cannot be
 * switched into however it is addressed.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

const MASTER = DEMO_ACCOUNTS[0];

describeDb('the development user switcher on PostgreSQL', () => {
  let db: Database;

  beforeAll(async () => {
    db = await openTestDatabase(url ?? '');
    startPostgresTestServer(url ?? '');
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seedBaseline(db);

    /*
     * The seeded Master, renamed to one of the switcher's addresses and given
     * the published development password — which is what the seed does, and
     * what the switcher verifies against.
     */
    await db
      .update(schema.users)
      .set({
        email: MASTER?.email ?? '',
        passwordHash: await hashPassword(DEVELOPMENT_PASSWORD),
      })
      .where(eq(schema.users.id, IDS.master));

    startPostgresTestServer(url ?? '');
  });

  it('signs in as the chosen account, with a real session', async () => {
    const client = new ApiTestClient();
    expect(client.token).toBeNull();

    const switched = await client.post('/api/dev/demo-users', { email: MASTER?.email ?? '' });
    expect(switched.status).toBe(200);
    expect(client.token).not.toBeNull();

    // An ORDINARY session row, indistinguishable from one the login form makes.
    const sessions = await db.select().from(schema.sessions);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.userId).toBe(IDS.master);
    expect(sessions[0]?.revokedAt).toBeNull();

    // And the server agrees about who is signed in.
    const me = await client.get<{ user: { email: string; role: string } }>('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.data.user.email).toBe(MASTER?.email);
    expect(me.data.user.role).toBe('master');
  });

  it('authorises the switched session exactly as a normal sign-in does', async () => {
    const client = new ApiTestClient();
    await client.post('/api/dev/demo-users', { email: MASTER?.email ?? '' });

    // Office screens open, because the SERVER knows this is a Master.
    expect((await client.get('/api/admin')).status).toBe(200);
    expect((await client.get('/api/jobs/closed')).status).toBe(200);
  });

  it('ends the session it switched away from', async () => {
    const client = new ApiTestClient();
    await client.post('/api/dev/demo-users', { email: MASTER?.email ?? '' });
    const first = client.token;

    await client.post('/api/dev/demo-users', { email: MASTER?.email ?? '' });
    expect(client.token).not.toBe(first);

    // The old token is revoked server-side, not merely replaced in the browser.
    expect((await client.get('/api/auth/me', { token: first })).status).toBe(401);

    const revoked = await db.select().from(schema.sessions);
    expect(revoked.filter((row) => row.revokedAt !== null)).toHaveLength(1);
  });

  it('refuses an account whose password is not the development one', async () => {
    // The same address, with a password somebody actually chose.
    await db
      .update(schema.users)
      .set({ passwordHash: await hashPassword('a-real-password-nobody-published') })
      .where(eq(schema.users.id, IDS.master));

    const client = new ApiTestClient();
    const response = await client.post('/api/dev/demo-users', { email: MASTER?.email ?? '' });

    expect(response.status).toBe(404);
    expect(client.token).toBeNull();
    expect(await db.select().from(schema.sessions)).toHaveLength(0);
  });

  it('refuses an account with no password set at all', async () => {
    await db
      .update(schema.users)
      .set({ passwordHash: null })
      .where(eq(schema.users.id, IDS.master));

    const response = await new ApiTestClient().post('/api/dev/demo-users', {
      email: MASTER?.email ?? '',
    });

    expect(response.status).toBe(404);
  });

  it('refuses a disabled account', async () => {
    await db
      .update(schema.users)
      .set({ active: false, disabledAt: new Date().toISOString() })
      .where(eq(schema.users.id, IDS.master));

    const response = await new ApiTestClient().post('/api/dev/demo-users', {
      email: MASTER?.email ?? '',
    });

    expect(response.status).toBe(404);
  });

  it('writes the sign-in to the audit trail, and says how it happened', async () => {
    await new ApiTestClient().post('/api/dev/demo-users', { email: MASTER?.email ?? '' });

    const events = await db.select().from(schema.auditEvents);
    const signedIn = events.find((event) => event.type === 'user_signed_in');

    expect(signedIn).toBeDefined();
    expect(signedIn?.detail).toContain('development user switcher');
    // Never the credential.
    expect(JSON.stringify(events)).not.toContain(DEVELOPMENT_PASSWORD);
  });
});
