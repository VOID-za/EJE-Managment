import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as schema from '@/db/schema';
import { IDS, seedBaseline } from '@/data/postgres/test-fixtures';
import { openTestDatabase, testDatabaseUrl, truncateAll } from '@/data/postgres/test-database';
import { hashPassword } from '@/server/auth/passwords';
import { ApiTestClient, startPostgresTestServer } from '@/test/api-harness';

/**
 * REFERRED CAPTURES, ON REAL POSTGRESQL. BD-15.
 *
 * `capture-referral-api.test.ts` proves the behaviour against the demonstration
 * backend. This file proves the parts that file cannot reach, which are exactly
 * the parts a persistence claim rests on:
 *
 *   1. THE ROW. A referral is a `capture_referrals` row with the technician's
 *      own idempotency key on it, not an object in a process that is about to
 *      exit.
 *   2. THE UNIQUE CAPTURE KEY. `(technician_id, idempotency_key)` is unique in
 *      the database, so one capture cannot become two referrals even if two
 *      requests race.
 *   3. THE CONDITIONAL RESOLVE. Resolving is an `UPDATE … WHERE state = 'open'`,
 *      so two office users deciding at once produce one decision and one
 *      refusal rather than a last-writer-wins overwrite.
 *   4. THE APPLIED WORK IS REAL. An applied referral leaves a `job_labour` row
 *      on the job, written through the ordinary operation.
 *   5. VISIBILITY SURVIVES A REASSIGNMENT, from `job_participants` — which is
 *      the precondition for the whole feature, since a reassignment is the most
 *      common reason a capture is refused in the first place.
 *
 * This file opens, truncates and seeds its own database (QA-6).
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

const PASSWORD = 'a-real-test-password';
const MASTER = 'elmarie@example-test.co.za';
const COORDINATOR = 'christene@example-test.co.za';
const TECHNICIAN = 'sipho@example-test.co.za';

const LABOUR = {
  date: '2026-10-17',
  rateType: 'normal',
  hours: 3,
  description: 'Stripped and refitted the drive',
} as const;

interface JobBody {
  readonly id: string;
  readonly jobNumber: string;
}
interface Referral {
  readonly id: string;
  readonly state: string;
  readonly idempotencyKey: string;
}

describeDb('work referred from a tablet, on PostgreSQL', () => {
  let db: Database;

  const signIn = async (email: string): Promise<ApiTestClient> => {
    const client = new ApiTestClient();
    const response = await client.signIn(email, PASSWORD);
    if (response.status !== 200) throw new Error(`sign-in failed for ${email}`);
    return client;
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

  /**
   * A breakdown Sipho accepted and then had taken off him — the situation BD-15
   * exists for. The capture he is holding is refused on arrival, because the
   * job is no longer his.
   */
  const jobTakenAway = async (): Promise<{
    master: ApiTestClient;
    tech: ApiTestClient;
    job: JobBody;
  }> => {
    const master = await signIn(MASTER);
    const created = await master.post<JobBody>('/api/jobs', {
      customerId: IDS.customer,
      siteId: IDS.site,
      contactId: IDS.contact,
      machineId: IDS.machine,
      jobType: 'breakdown',
      priority: 'urgent',
      scheduledDate: null,
      scheduledEndDate: null,
      orderNumber: 'PO-92000',
      referenceNumber: '',
      faultDescription: 'Drive tripping under load.',
      primaryTechnicianId: IDS.technician,
      courierCollection: false,
      deliveryNote: '',
    });
    expect(created.status).toBe(200);

    const tech = await signIn(TECHNICIAN);
    expect((await tech.post(`/api/jobs/${created.data.id}/accept`)).status).toBe(200);
    expect(
      (
        await master.post(`/api/jobs/${created.data.id}/assign_primary`, {
          technicianId: IDS.otherTechnician,
        })
      ).status,
    ).toBe(200);

    return { master, tech, job: created.data };
  };

  const refer = (tech: ApiTestClient, job: JobBody, key: string) =>
    tech.post<{ referral: Referral }>('/api/captures/referrals', {
      jobId: job.id,
      action: 'add_labour',
      payload: LABOUR,
      summary: '3 h normal — Stripped and refitted the drive',
      capturedAt: '2026-10-17T09:14:00.000Z',
      idempotencyKey: key,
      refusalCode: 'not_on_job',
      refusalMessage: 'You can only capture work on a job you are working on.',
    });

  it('refuses the late capture, then stores the referral as a real row', async () => {
    const { tech, job } = await jobTakenAway();

    const refused = await tech.post(`/api/jobs/${job.id}/add_labour`, LABOUR, {
      idempotencyKey: 'capture-held-in-a-basement',
    });
    expect(refused.status).toBe(422);

    const referred = await refer(tech, job, 'capture-held-in-a-basement');
    expect(referred.status).toBe(200);

    const rows = await db.select().from(schema.captureReferrals);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.jobId).toBe(job.id);
    expect(rows[0]?.technicianId).toBe(IDS.technician);
    expect(rows[0]?.action).toBe('add_labour');
    expect(rows[0]?.state).toBe('open');
    // The tablet's own key, kept — this is the attempt the capture was made under.
    expect(rows[0]?.idempotencyKey).toBe('capture-held-in-a-basement');
    expect(rows[0]?.refusalCode).toBe('not_on_job');
    // And the hours are NOT on the job, because the job refused them.
    expect(await db.select().from(schema.jobLabour)).toHaveLength(0);
  });

  it('keeps one row for one capture, however often the tablet refers it', async () => {
    const { tech, job } = await jobTakenAway();
    const first = await refer(tech, job, 'capture-referred-twice');
    const again = await refer(tech, job, 'capture-referred-twice');

    expect(again.status).toBe(200);
    expect(again.data.referral.id).toBe(first.data.referral.id);
    expect(await db.select().from(schema.captureReferrals)).toHaveLength(1);
  });

  it('has the unique capture key in the DATABASE, not only in the application', async () => {
    const { tech, job } = await jobTakenAway();
    await refer(tech, job, 'capture-with-a-unique-key');

    // Written straight past the application, the way a race would arrive.
    const second = db.insert(schema.captureReferrals).values({
      id: 'ref-written-by-hand',
      jobId: job.id,
      technicianId: IDS.technician,
      action: 'add_labour',
      payload: LABOUR,
      summary: 'A second row for one capture',
      capturedAt: '2026-10-17T09:14:00.000Z',
      idempotencyKey: 'capture-with-a-unique-key',
      refusalCode: 'not_on_job',
      refusalMessage: 'Refused.',
      referredAt: '2026-10-17T10:00:00.000Z',
      state: 'open',
      resolutionNote: '',
    });

    await expect(second).rejects.toThrow(/duplicate key|unique/iu);
  });

  it('applies a referred capture as a real labour row on the job', async () => {
    const { master, tech, job } = await jobTakenAway();
    const referral = await refer(tech, job, 'capture-to-apply');

    const applied = await master.post(`/api/captures/referrals/${referral.data.referral.id}/resolve`, {
      resolution: 'applied',
    });
    expect(applied.status).toBe(200);

    const labour = await db.select().from(schema.jobLabour).where(eq(schema.jobLabour.jobId, job.id));
    expect(labour).toHaveLength(1);
    expect(Number(labour[0]?.hours)).toBe(3);

    const rows = await db.select().from(schema.captureReferrals);
    expect(rows[0]?.state).toBe('resolved');
    expect(rows[0]?.resolution).toBe('applied');
    expect(rows[0]?.resolvedBy).toBe(IDS.master);
    expect(rows[0]?.resolvedAt).not.toBeNull();

    // Both lines are on the job's history, naming what happened.
    const events = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.jobId, job.id));
    const types = events.map((event) => event.type);
    expect(types, JSON.stringify(types)).toContain('capture_referred');
    expect(types, JSON.stringify(types)).toContain('capture_referral_resolved');
  });

  it('settles two office users deciding at once with one decision and one refusal', async () => {
    const { master, tech, job } = await jobTakenAway();
    const coordinator = await signIn(COORDINATOR);
    const referral = await refer(tech, job, 'capture-decided-twice');
    const path = `/api/captures/referrals/${referral.data.referral.id}/resolve`;

    const [first, second] = await Promise.all([
      master.post(path, { resolution: 'no_action', note: 'Captured on the other job.' }),
      coordinator.post(path, { resolution: 'no_action', note: 'Nothing to apply.' }),
    ]);

    const statuses = [first.status, second.status].sort((left, right) => left - right);
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).not.toBe(200);
    expect(statuses[1]).toBeLessThan(500);

    // One decision, and it is one of the two that were offered.
    const rows = await db.select().from(schema.captureReferrals);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('resolved');
    expect([IDS.master, IDS.coordinator]).toContain(rows[0]?.resolvedBy);
    // `no_action` means it: nothing reached the job.
    expect(await db.select().from(schema.jobLabour)).toHaveLength(0);
  });

  it('keeps the technician’s access to the job after it is taken off them', async () => {
    /*
     * `job_participants`, which is what makes the rest of this file possible: a
     * technician who cannot see the job can neither read their own captured
     * work on it nor hand the office the capture the reassignment caused to be
     * refused.
     */
    const { tech, job } = await jobTakenAway();

    const view = await tech.get(`/api/jobs/${job.jobNumber}`);
    expect(view.status).toBe(200);

    const participants = await db
      .select()
      .from(schema.jobParticipants)
      .where(eq(schema.jobParticipants.jobId, job.id));
    const mine = participants.filter((row) => row.userId === IDS.technician);
    expect(mine).toHaveLength(1);
    // Closed, not deleted: they were on it, and no longer are.
    expect(mine[0]?.until).not.toBeNull();
  });

  it('refuses to delete a job that still has a referred capture against it', async () => {
    const { tech, job } = await jobTakenAway();
    await refer(tech, job, 'capture-against-a-deleted-job');

    // RESTRICT, not CASCADE: a technician's unresolved hours are not collateral
    // damage of a job being removed. The office resolves it first.
    await expect(db.delete(schema.jobs).where(eq(schema.jobs.id, job.id))).rejects.toThrow();

    // And the refusal is the database's: both rows are still there.
    expect(await db.select().from(schema.captureReferrals)).toHaveLength(1);
    expect(
      await db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id)),
    ).toHaveLength(1);
  });
});
