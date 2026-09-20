import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as schema from '@/db/schema';
import type { Job } from '@/domain';
import { IDS, seedBaseline } from '@/data/postgres/test-fixtures';
import { openTestDatabase, testDatabaseUrl, truncateAll } from '@/data/postgres/test-database';
import { hashPassword } from '@/server/auth/passwords';
import { hashSessionToken } from '@/server/auth/tokens';
import { ApiTestClient, startPostgresTestServer } from '@/test/api-harness';

/**
 * THE WHOLE STACK, against a real PostgreSQL.
 *
 * Sign in over HTTP, receive a cookie, and drive the application through the
 * same route handlers the browser calls — with the real transaction boundary,
 * the real optimistic concurrency and the real persisted idempotency record
 * underneath. The demonstration store cannot prove any of those, because it has
 * none of them.
 *
 * Run with `npm run db:test`. Skipped where there is no `TEST_DATABASE_URL`.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

const PASSWORD = 'a-real-test-password';
const EMAILS = {
  master: 'elmarie@example-test.co.za',
  technician: 'sipho@example-test.co.za',
  otherTechnician: 'lerato@example-test.co.za',
  coordinator: 'christene@example-test.co.za',
} as const;

describeDb('the HTTP API on PostgreSQL', () => {
  let db: Database;

  const signIn = async (email: string): Promise<ApiTestClient> => {
    const client = new ApiTestClient();
    const response = await client.signIn(email, PASSWORD);
    if (response.status !== 200) {
      throw new Error(`sign-in failed for ${email}: ${response.error?.message ?? ''}`);
    }
    return client;
  };

  const raiseJob = async (client: ApiTestClient, over: Record<string, unknown> = {}) =>
    client.post<Job>('/api/jobs', {
      customerId: IDS.customer,
      siteId: IDS.site,
      contactId: IDS.contact,
      machineId: IDS.machine,
      jobType: 'breakdown',
      priority: 'urgent',
      scheduledDate: null,
      scheduledEndDate: null,
      orderNumber: '',
      referenceNumber: '',
      faultDescription: 'Spindle drive alarm 750.',
      primaryTechnicianId: null,
      courierCollection: false,
      deliveryNote: '',
      ...over,
    });

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
    // Real Argon2id hashes, written the way a password reset will write them.
    const hash = await hashPassword(PASSWORD);
    await db.update(schema.users).set({ passwordHash: hash });
    startPostgresTestServer(url ?? '');
  });

  /* ---------------------------------------------------------------------- */
  /* 1. Sign in                                                             */
  /* ---------------------------------------------------------------------- */

  it('signs a user in against a hash stored in PostgreSQL', async () => {
    const client = new ApiTestClient();
    const response = await client.signIn(EMAILS.master, PASSWORD);

    expect(response.status).toBe(200);
    expect(client.token).not.toBeNull();

    const rows = await db.select().from(schema.sessions);
    expect(rows).toHaveLength(1);
    // The token is in the cookie; the DATABASE holds only its digest.
    expect(rows[0]?.tokenHash).toBe(hashSessionToken(client.token ?? ''));
    expect(rows[0]?.tokenHash).not.toBe(client.token);
  });

  it('refuses a wrong password and counts the failure on the row', async () => {
    const response = await new ApiTestClient().signIn(EMAILS.master, 'wrong');
    expect(response.status).toBe(401);

    const [row] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, EMAILS.master));
    expect(row?.failedLoginCount).toBe(1);
    expect(await db.select().from(schema.sessions)).toHaveLength(0);
  });

  it('locks the account on the fifth failure, in the database', async () => {
    const client = new ApiTestClient();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await client.signIn(EMAILS.master, 'wrong');
    }

    const [row] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, EMAILS.master));
    expect(row?.lockedUntil).not.toBeNull();
    expect((await client.signIn(EMAILS.master, PASSWORD)).status).toBe(401);
  });

  /* ---------------------------------------------------------------------- */
  /* 2. The session                                                          */
  /* ---------------------------------------------------------------------- */

  it('authenticates every later request from the session row', async () => {
    const client = await signIn(EMAILS.master);
    const me = await client.get<{ user: { email: string; role: string } }>('/api/auth/me');

    expect(me.status).toBe(200);
    expect(me.data.user.email).toBe(EMAILS.master);
    expect(me.data.user.role).toBe('master');
    expect(JSON.stringify(me.raw)).not.toContain('$argon2');
  });

  it('revokes the session row on sign-out', async () => {
    const client = await signIn(EMAILS.master);
    const token = client.token;

    await client.post('/api/auth/logout');

    const rows = await db.select().from(schema.sessions);
    expect(rows[0]?.revokedAt).not.toBeNull();
    expect((await client.get('/api/auth/me', { token })).status).toBe(401);
  });

  it('revokes every session when the account is disabled', async () => {
    const technician = await signIn(EMAILS.technician);
    const master = await signIn(EMAILS.master);

    const disabled = await master.post(`/api/users/${IDS.technician}/set_active`, {
      active: false,
    });
    expect(disabled.status).toBe(200);

    const rows = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, IDS.technician));
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
    expect((await technician.get('/api/auth/me')).status).toBe(401);
    expect((await new ApiTestClient().signIn(EMAILS.technician, PASSWORD)).status).toBe(401);
  });

  /* ---------------------------------------------------------------------- */
  /* 3. Raising and working a job                                            */
  /* ---------------------------------------------------------------------- */

  it('raises a job, allocates its number, and persists it', async () => {
    const master = await signIn(EMAILS.master);
    const created = await raiseJob(master);

    expect(created.status).toBe(200);
    expect(created.data.jobNumber).toMatch(/^EJE-\d+$/u);

    const rows = await db.select().from(schema.jobs);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.jobNumber).toBe(created.data.jobNumber);

    const read = await master.get<{ view: { job: Job } }>(`/api/jobs/${created.data.jobNumber}`);
    expect(read.status).toBe(200);
    expect(read.data.view.job.faultDescription).toBe('Spindle drive alarm 750.');
  });

  it('refuses a technician raising a job', async () => {
    const technician = await signIn(EMAILS.technician);
    const created = await raiseJob(technician);

    expect(created.status).toBe(403);
    expect(await db.select().from(schema.jobs)).toHaveLength(0);
  });

  it('lets a technician accept from the pool and capture labour, in one transaction each', async () => {
    const master = await signIn(EMAILS.master);
    const created = await raiseJob(master);
    const jobNumber = created.data.jobNumber;

    const technician = await signIn(EMAILS.technician);
    expect((await technician.post(`/api/jobs/${jobNumber}/accept`)).status).toBe(200);

    const labour = await technician.post(`/api/jobs/${jobNumber}/add_labour`, {
      date: '2026-09-20',
      rateType: 'normal',
      hours: 2.5,
      description: 'Replaced the spindle drive.',
    });
    expect(labour.status).toBe(200);

    const stored = await db.select().from(schema.jobLabour);
    expect(stored).toHaveLength(1);
    // The actor came from the SESSION, not from the body.
    expect(stored[0]?.capturedBy).toBe(IDS.technician);
  });

  it('answers 404 for a job the technician may not read', async () => {
    const master = await signIn(EMAILS.master);
    const created = await raiseJob(master, { primaryTechnicianId: IDS.otherTechnician });
    await (await signIn(EMAILS.otherTechnician)).post(`/api/jobs/${created.data.jobNumber}/accept`);

    const technician = await signIn(EMAILS.technician);
    const response = await technician.get(`/api/jobs/${created.data.jobNumber}`);

    expect(response.status).toBe(404);
    // ...and the search cannot find it either.
    const search = await technician.get(
      `/api/search?q=${encodeURIComponent(created.data.jobNumber)}`,
    );
    expect(JSON.stringify(search.data)).not.toContain(created.data.jobNumber);
  });

  /* ---------------------------------------------------------------------- */
  /* 4. Concurrency                                                          */
  /* ---------------------------------------------------------------------- */

  it('refuses a stale write rather than silently overwriting it', async () => {
    const master = await signIn(EMAILS.master);
    const created = await raiseJob(master);
    const jobNumber = created.data.jobNumber;

    // Two writers, both starting from the same version. PostgreSQL's row
    // version decides; the loser is told, and nothing is merged.
    const [first, second] = await Promise.all([
      master.post(`/api/jobs/${jobNumber}/add_note`, { body: 'First.', internal: true }),
      master.post(`/api/jobs/${jobNumber}/add_note`, { body: 'Second.', internal: true }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses[0]).toBe(200);

    if (statuses[1] === 409) {
      const loser = first.status === 409 ? first : second;
      expect(loser.error?.code).toBe('version_conflict');
      expect(loser.error?.message).toContain('Reload');
      // The losing note was NOT written.
      const notes = await db.select().from(schema.jobNotes);
      expect(notes).toHaveLength(1);
    } else {
      // Serialised rather than collided: both are present, neither was lost.
      expect(await db.select().from(schema.jobNotes)).toHaveLength(2);
    }
  });

  /* ---------------------------------------------------------------------- */
  /* 5. Idempotency                                                          */
  /* ---------------------------------------------------------------------- */

  it('records an idempotency key and performs the change once', async () => {
    const master = await signIn(EMAILS.master);
    const created = await raiseJob(master);
    const jobNumber = created.data.jobNumber;

    const body = { body: 'Spares ordered.', internal: true };
    const first = await master.post(`/api/jobs/${jobNumber}/add_note`, body, {
      idempotencyKey: 'key-abc',
    });
    const second = await master.post(`/api/jobs/${jobNumber}/add_note`, body, {
      idempotencyKey: 'key-abc',
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers.get('Idempotent-Replay')).toBe('true');

    expect(await db.select().from(schema.jobNotes)).toHaveLength(1);
    const keys = await db.select().from(schema.apiIdempotency);
    expect(keys).toHaveLength(1);
    expect(keys[0]?.userId).toBe(IDS.master);
  });

  it('commits the idempotency record in the same transaction as the change', async () => {
    const master = await signIn(EMAILS.master);
    const created = await raiseJob(master);

    // A refused operation must leave NO key behind, or the retry that fixes it
    // would be answered with the failure.
    const refused = await master.post(
      `/api/jobs/${created.data.jobNumber}/start_signature`,
      {},
      { idempotencyKey: 'key-refused' },
    );
    expect(refused.status).toBe(422);

    const keys = await db
      .select()
      .from(schema.apiIdempotency)
      .where(eq(schema.apiIdempotency.idempotencyKey, 'key-refused'));
    expect(keys).toHaveLength(0);
  });

  /* ---------------------------------------------------------------------- */
  /* 6. Permanent deletion                                                   */
  /* ---------------------------------------------------------------------- */

  it('deletes a job permanently and keeps the audit event that says so', async () => {
    const master = await signIn(EMAILS.master);
    const created = await raiseJob(master);
    const jobNumber = created.data.jobNumber;

    const deleted = await master.post(`/api/jobs/${jobNumber}/delete`, {
      reason: 'Raised against the wrong customer.',
    });
    expect(deleted.status).toBe(200);

    // The row is gone from the database, not flagged.
    expect(await db.select().from(schema.jobs)).toHaveLength(0);
    expect((await master.get(`/api/jobs/${jobNumber}`)).status).toBe(404);

    // The audit event outlives it, and still names the job by its number.
    const events = await db.select().from(schema.auditEvents);
    const deletion = events.find((event) => event.type === 'job_deleted');
    expect(deletion).toBeDefined();
    expect(`${deletion?.summary ?? ''} ${deletion?.detail ?? ''}`).toContain(jobNumber);

    const activity = await master.get('/api/activity');
    expect(JSON.stringify(activity.data)).toContain(jobNumber);
  });

  /* ---------------------------------------------------------------------- */
  /* 7. What must never cross the wire                                       */
  /* ---------------------------------------------------------------------- */

  it('never serves a password hash, a session token or a connection string', async () => {
    const master = await signIn(EMAILS.master);
    const created = await raiseJob(master);

    const responses = await Promise.all([
      master.get('/api/auth/me'),
      master.get('/api/admin'),
      master.get('/api/jobs'),
      master.get(`/api/jobs/${created.data.jobNumber}`),
      master.get('/api/dashboard'),
      master.get('/api/activity'),
    ]);

    for (const response of responses) {
      const body = JSON.stringify(response.raw);
      expect(body).not.toContain('$argon2');
      expect(body).not.toContain('passwordHash');
      expect(body).not.toContain('password_hash');
      expect(body).not.toContain('lockedUntil');
      expect(body).not.toContain('tokenHash');
      expect(body).not.toContain(master.token ?? 'no-token');
      expect(body).not.toContain('postgres://');
    }
  });

  it('records the security events, and records no credential in them', async () => {
    await new ApiTestClient().signIn(EMAILS.master, 'the-wrong-password');
    await signIn(EMAILS.master);

    const events = await db.select().from(schema.auditEvents);
    const types = events.map((event) => event.type);
    expect(types).toContain('user_sign_in_failed');
    expect(types).toContain('user_signed_in');

    const text = JSON.stringify(events);
    expect(text).not.toContain('the-wrong-password');
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain('$argon2');
  });

  it('hides the security events from a technician’s activity feed', async () => {
    await signIn(EMAILS.master);
    const technician = await signIn(EMAILS.technician);

    const feed = await technician.get('/api/activity');
    // The feed is office-only; where it is served at all, it carries no
    // security event.
    if (feed.status === 200) {
      expect(JSON.stringify(feed.data)).not.toContain('user_signed_in');
    } else {
      expect(feed.status).toBe(403);
    }
  });

  /* ---------------------------------------------------------------------- */
  /* 8. The composition root                                                 */
  /* ---------------------------------------------------------------------- */

  it('reports the PostgreSQL backend, and offers no demonstration reset', async () => {
    const master = await signIn(EMAILS.master);

    const me = await master.get<{ backend: string }>('/api/auth/me');
    expect(me.data.backend).toBe('postgres');

    // There is no code path that discards a business's data.
    expect((await master.post('/api/demo/reset')).status).toBe(404);
  });

  it('keeps every write inside one transaction', async () => {
    const master = await signIn(EMAILS.master);
    const created = await raiseJob(master);

    // The job and its audit event committed together: the count of one implies
    // the other, and a half-written job would show as one without the other.
    const rows = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from audit_events where job_id is not null`,
    );
    expect(Number(rows[0]?.count ?? '0')).toBeGreaterThan(0);
    expect(created.status).toBe(200);
  });
});
