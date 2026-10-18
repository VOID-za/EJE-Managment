import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as schema from '@/db/schema';
import type { Job } from '@/domain';
import { IDS, seedBaseline } from '@/data/postgres/test-fixtures';
import { openTestDatabase, testDatabaseUrl, truncateAll } from '@/data/postgres/test-database';
import { hashPassword } from '@/server/auth/passwords';
import { ApiTestClient, startPostgresTestServer } from '@/test/api-harness';

/**
 * THE OFFLINE QUEUE'S REPLAY, AGAINST REAL POSTGRESQL. OFF-QUEUE-4…7, IDEM-2.
 *
 * A tablet holds captures and sends them later, each under the key it was
 * FIRST attempted with. Everything that makes that safe is a property of the
 * database and the transaction boundary, so it cannot be proved against the
 * demonstration store:
 *
 *  1. A REPLAY ADDS NOTHING. The same key sent twice — or twice at once,
 *     which is what a flush racing a reconnect does — leaves one line.
 *  2. A KEY BELONGS TO ITS OWNER. One technician's key cannot answer another
 *     technician's request, and cannot reach a job that is not theirs. This is
 *     the shared-tablet case: two accounts, one device, one queue store.
 *  3. A CAPTURE THE JOB HAS MOVED PAST IS REFUSED, repeatedly and identically,
 *     and leaves nothing behind — neither a line nor an idempotency record
 *     that would answer the retry with the refusal.
 *  4. A REVOKED SESSION CANNOT SYNC. The tablet may have been holding work for
 *     hours; if the account was disabled or signed out in the meantime, the
 *     flush is refused by authentication and writes nothing.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

const PASSWORD = 'a-real-test-password';
const EMAILS = {
  master: 'elmarie@example-test.co.za',
  technician: 'sipho@example-test.co.za',
  otherTechnician: 'lerato@example-test.co.za',
} as const;

/** The body the queue holds for a labour capture, exactly as the route takes it. */
const LABOUR = {
  date: '2026-10-18',
  rateType: 'normal',
  hours: 3.5,
  description: 'Replaced the drive fan and ran the machine under load.',
} as const;

describeDb('replaying a tablet’s queue against PostgreSQL', () => {
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

  /** A job this technician has accepted, which is what a queue captures against. */
  const acceptedJob = async (): Promise<{ jobNumber: string; technician: ApiTestClient }> => {
    const master = await signIn(EMAILS.master);
    const created = await raiseJob(master);
    const technician = await signIn(EMAILS.technician);
    const accepted = await technician.post(`/api/jobs/${created.data.jobNumber}/accept`);
    expect(accepted.status).toBe(200);
    return { jobNumber: created.data.jobNumber, technician };
  };

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
    const hash = await hashPassword(PASSWORD);
    await db.update(schema.users).set({ passwordHash: hash });
    startPostgresTestServer(url ?? '');
  });

  it('adds one labour line when the same held capture is sent twice', async () => {
    const { jobNumber, technician } = await acceptedJob();

    const first = await technician.post(`/api/jobs/${jobNumber}/add_labour`, LABOUR, {
      idempotencyKey: 'held-capture-1',
    });
    const second = await technician.post(`/api/jobs/${jobNumber}/add_labour`, LABOUR, {
      idempotencyKey: 'held-capture-1',
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers.get('Idempotent-Replay')).toBe('true');
    expect(await db.select().from(schema.jobLabour)).toHaveLength(1);
  });

  /*
   * A FLUSH RACING A RECONNECT sends the same row twice at once. Whichever
   * answer each request gets, the job must carry ONE line — the technician
   * captured three and a half hours, not seven.
   */
  it('adds one labour line when two sends of the same capture arrive together', async () => {
    const { jobNumber, technician } = await acceptedJob();

    const [a, b] = await Promise.all([
      technician.post(`/api/jobs/${jobNumber}/add_labour`, LABOUR, {
        idempotencyKey: 'held-capture-2',
      }),
      technician.post(`/api/jobs/${jobNumber}/add_labour`, LABOUR, {
        idempotencyKey: 'held-capture-2',
      }),
    ]);

    expect([a.status, b.status].filter((status) => status === 200).length).toBeGreaterThan(0);
    for (const answer of [a, b]) {
      expect([200, 409]).toContain(answer.status);
    }
    expect(await db.select().from(schema.jobLabour)).toHaveLength(1);

    const keys = await db
      .select()
      .from(schema.apiIdempotency)
      .where(eq(schema.apiIdempotency.userId, IDS.technician));
    expect(keys).toHaveLength(1);
  });

  /*
   * THE SHARED TABLET. Two accounts, one device: one technician's queued key
   * must not answer the other's request, and must not reach a job that is not
   * theirs.
   */
  it('keeps one technician’s key out of another technician’s hands', async () => {
    const { jobNumber, technician } = await acceptedJob();
    const sent = await technician.post(`/api/jobs/${jobNumber}/add_labour`, LABOUR, {
      idempotencyKey: 'shared-tablet-key',
    });
    expect(sent.status).toBe(200);

    // The same key, the same body, a different person — on a job they are not
    // on at all. The read refuses it before the key is ever considered.
    const other = await signIn(EMAILS.otherTechnician);
    const replayed = await other.post(`/api/jobs/${jobNumber}/add_labour`, LABOUR, {
      idempotencyKey: 'shared-tablet-key',
    });
    expect(replayed.status).toBe(404);
    expect(JSON.stringify(replayed.raw)).not.toContain(LABOUR.description);

    // One line, captured by its own technician, and one key — theirs.
    const labour = await db.select().from(schema.jobLabour);
    expect(labour).toHaveLength(1);
    expect(labour[0]?.capturedBy).toBe(IDS.technician);
    const keys = await db.select().from(schema.apiIdempotency);
    expect(keys).toHaveLength(1);
    expect(keys[0]?.userId).toBe(IDS.technician);
  });

  /*
   * THE CAPTURE WHOSE JOB WAS REASSIGNED. BD-15 is what happens next on the
   * tablet — the capture is retained and referred to the office — and what the
   * SERVER must do is refuse it the same way every time and write nothing.
   *
   * Reassignment is the case the offline mandate names, and it is the one a
   * queue cannot see coming: the technician was on the job when they captured
   * the hours in a basement, and the office moved it to somebody else while
   * they were down there.
   *
   * NOT `completion`: a technician writing up a job may still add a line they
   * forgot, and the domain allows it deliberately — asserting a refusal there
   * would have been asserting a defect.
   */
  it('refuses a held capture whose job was reassigned, identically each time', async () => {
    const { jobNumber, technician } = await acceptedJob();

    const master = await signIn(EMAILS.master);
    const moved = await master.post(`/api/jobs/${jobNumber}/transfer_to_technician`, {
      technicianId: IDS.otherTechnician,
      reason: 'requires_another_technician',
      description: 'The drive specialist is taking it.',
    });
    expect(moved.status).toBe(200);

    const attempts: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const refused = await technician.post(`/api/jobs/${jobNumber}/add_labour`, LABOUR, {
        idempotencyKey: 'stale-capture-1',
      });
      attempts.push(refused.status);
      expect(refused.error?.message.length ?? 0).toBeGreaterThan(0);
      // The refusal says nothing about the job's contents.
      expect(JSON.stringify(refused.raw)).not.toContain(LABOUR.description);
    }

    // The same answer every time — a retry does not eventually succeed.
    expect(new Set(attempts).size).toBe(1);
    /*
     * 422 AND NOT 404, and the distinction is the right one: the technician
     * can still SEE the job they worked on — DECISION 5 keeps the work they
     * participated in readable — so hiding it would be a lie. What they may no
     * longer do is capture against it, which is a workflow refusal. The tablet
     * reads 422 as "a person must decide" and refers the capture to the office
     * (BD-15) instead of retrying it for ever.
     */
    expect(attempts[0], `statuses: ${attempts.join(',')}`).toBe(422);

    // Nothing written, and NO idempotency record: a refused operation must not
    // answer its own retry from a stored failure.
    expect(await db.select().from(schema.jobLabour)).toHaveLength(0);
    expect(await db.select().from(schema.apiIdempotency)).toHaveLength(0);
  });

  it('refuses a flush from a session that was revoked while the work waited', async () => {
    const { jobNumber, technician } = await acceptedJob();

    // Signed out at the gate, or the account disabled — either way the session
    // row is gone and the cookie the tablet holds is worth nothing.
    expect((await technician.post('/api/auth/logout')).status).toBe(200);

    const replayed = await technician.post(`/api/jobs/${jobNumber}/add_labour`, LABOUR, {
      idempotencyKey: 'revoked-session-1',
      token: 'forged-or-stale-token',
    });
    expect(replayed.status).toBe(401);
    expect(await db.select().from(schema.jobLabour)).toHaveLength(0);
    expect(await db.select().from(schema.apiIdempotency)).toHaveLength(0);
  });
});
