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
 * DUPLICATE ACCEPTANCE ON REAL POSTGRESQL. MASTER SCOPE IDEM-2.
 *
 * WHAT ONLY THIS CAN SHOW. The demonstration backend proves the rule; it cannot
 * prove the mechanism production actually relies on. On PostgreSQL nothing is
 * serialised at the read: two requests both open a transaction, both read the
 * job at `open`, and both decide it may be accepted. What separates them is the
 * WRITE — every optimistic update says `where version = $expected`, so the
 * second one changes no rows, `requireWritten` raises `ConcurrencyError`, and
 * the whole transaction rolls back with it.
 *
 * So the assertions below are about what is IN THE TABLES afterwards, which is
 * the only place that claim can be settled: one `job_accepted` event, one
 * accepted-at, one row version step.
 *
 * Run with `npm run db:test`. Skipped where there is no `TEST_DATABASE_URL`.
 *
 * DUPLICATE SUBMISSION IS NOT HERE, and its absence is deliberate rather than
 * an oversight. Issuing a signed job card cannot complete on PostgreSQL at all
 * today: `JobRepository.save` rewrites a job's children by deleting them, and
 * migration `0007_signed_job_immutability.sql` forbids DELETE on `job_labour`,
 * `job_travel`, `job_parts` and `job_notes` once a signature exists — so
 * `POST /api/jobs/:id/issue` answers 500 for any signed job carrying so much as
 * one labour line. That is a defect in the submission path, not in IDEM-2, and
 * writing a duplicate-submission test here would assert the wrong thing for the
 * wrong reason. It is reported rather than worked around; the demonstration
 * backend and the application layer carry the duplicate-submission proof in the
 * meantime.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

const PASSWORD = 'a-real-test-password';
const MASTER = 'elmarie@example-test.co.za';
const TECHNICIAN = 'sipho@example-test.co.za';

describeDb('duplicate acceptance on PostgreSQL', () => {
  let db: Database;

  const signIn = async (email: string): Promise<ApiTestClient> => {
    const client = new ApiTestClient();
    const response = await client.signIn(email, PASSWORD);
    if (response.status !== 200) throw new Error(`sign-in failed for ${email}`);
    return client;
  };

  const raise = (client: ApiTestClient) =>
    client.post<Job>('/api/jobs', {
      customerId: IDS.customer,
      siteId: IDS.site,
      contactId: IDS.contact,
      machineId: IDS.machine,
      jobType: 'breakdown',
      priority: 'urgent',
      scheduledDate: null,
      scheduledEndDate: null,
      orderNumber: 'PO-81000',
      referenceNumber: '',
      faultDescription: 'Spindle drive alarm 750.',
      primaryTechnicianId: IDS.technician,
      courierCollection: false,
      deliveryNote: '',
    });

  const acceptedEvents = async (jobId: string): Promise<number> => {
    const events = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.jobId, jobId));
    return events.filter((event) => event.type === 'job_accepted').length;
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
    await db.update(schema.users).set({ passwordHash: await hashPassword(PASSWORD) });
    startPostgresTestServer(url ?? '');
  });

  it('accepts once when two requests arrive together, and says so to the loser', async () => {
    const job = await raise(await signIn(MASTER));
    const technician = await signIn(TECHNICIAN);

    const [a, b] = await Promise.all([
      technician.post<Job>(`/api/jobs/${job.data.id}/accept`),
      technician.post<Job>(`/api/jobs/${job.data.id}/accept`),
    ]);

    const winners = [a, b].filter((response) => response.status === 200);
    const losers = [a, b].filter((response) => response.status !== 200);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    /*
     * THE EXISTING CONFLICT SEMANTIC, UNCHANGED. The row version is what
     * refused this, so the answer is the one a stale write already got: 409,
     * `version_conflict`, and a sentence telling the caller to reload. Nothing
     * new was invented for the duplicate case.
     */
    expect(losers[0]?.status).toBe(409);
    expect(losers[0]?.error?.code).toBe('version_conflict');

    // What the tables say, which is the only claim that matters.
    expect(await acceptedEvents(job.data.id)).toBe(1);
    const rows = await db.select().from(schema.jobs).where(eq(schema.jobs.id, job.data.id));
    expect(rows[0]?.status).toBe('in_progress');
    expect(rows[0]?.acceptedAt).not.toBeNull();
  });

  it('accepts once under a burst of five', async () => {
    const job = await raise(await signIn(MASTER));
    const technician = await signIn(TECHNICIAN);

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => technician.post<Job>(`/api/jobs/${job.data.id}/accept`)),
    );

    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    // Every refusal is a refusal, and not one of them is a 500.
    for (const response of responses.filter((response) => response.status !== 200)) {
      expect([409, 422]).toContain(response.status);
    }
    expect(await acceptedEvents(job.data.id)).toBe(1);
  });

  it('refuses a second acceptance that arrives after the first has committed', async () => {
    const job = await raise(await signIn(MASTER));
    const technician = await signIn(TECHNICIAN);

    expect((await technician.post(`/api/jobs/${job.data.id}/accept`)).status).toBe(200);
    const again = await technician.post<Job>(`/api/jobs/${job.data.id}/accept`);

    // Read fresh, refused by the state machine: `in_progress` has no edge back
    // to itself.
    expect(again.status).toBe(422);
    expect(again.error?.violations?.[0]?.code).toBe('illegal_transition');
    expect(await acceptedEvents(job.data.id)).toBe(1);
  });

  it('replays a retried acceptance from the idempotency record, and accepts once', async () => {
    const job = await raise(await signIn(MASTER));
    const technician = await signIn(TECHNICIAN);
    const key = 'accept-after-a-dropped-connection';

    const first = await technician.post<Job>(`/api/jobs/${job.data.id}/accept`, undefined, {
      idempotencyKey: key,
    });
    const retry = await technician.post<Job>(`/api/jobs/${job.data.id}/accept`, undefined, {
      idempotencyKey: key,
    });

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.headers.get('Idempotent-Replay')).toBe('true');
    expect(retry.data.acceptedAt).toBe(first.data.acceptedAt);

    expect(await acceptedEvents(job.data.id)).toBe(1);
    // The marker and the change committed together: one key, one acceptance.
    const keys = await db.select().from(schema.apiIdempotency);
    expect(keys).toHaveLength(1);
    expect(keys[0]?.operation).toBe('jobs.accept');
  });

  it('records no acceptance at all when the loser rolls back', async () => {
    const job = await raise(await signIn(MASTER));
    const technician = await signIn(TECHNICIAN);

    const before = await db.select().from(schema.jobs).where(eq(schema.jobs.id, job.data.id));
    await Promise.all([
      technician.post<Job>(`/api/jobs/${job.data.id}/accept`),
      technician.post<Job>(`/api/jobs/${job.data.id}/accept`),
    ]);
    const after = await db.select().from(schema.jobs).where(eq(schema.jobs.id, job.data.id));

    /*
     * ONE VERSION STEP, NOT TWO.
     *
     * The losing transaction wrote nothing — not the job, not its audit row,
     * not a participation record — because the version check raised before it
     * could commit and took the whole transaction with it.
     */
    expect((after[0]?.version ?? 0) - (before[0]?.version ?? 0)).toBe(1);
    expect(await acceptedEvents(job.data.id)).toBe(1);
  });
});
