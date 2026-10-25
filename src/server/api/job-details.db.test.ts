import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as schema from '@/db/schema';
import type { Job } from '@/domain';
import { IDS, seedBaseline } from '@/data/postgres/test-fixtures';
import { openTestDatabase, testDatabaseUrl, truncateAll } from '@/data/postgres/test-database';
import { hashPassword } from '@/server/auth/passwords';
import { ApiTestClient, startPostgresTestServer } from '@/test/api-harness';

/**
 * JOB-EDIT-1 (#72) ON PostgreSQL, through the real routes.
 *
 * What only this layer can prove:
 *
 *  - THE CORRECTION IS PERSISTED, in the columns themselves, and the job row's
 *    version moves — so the optimistic concurrency underneath the stale-value
 *    check is really in play.
 *  - THE AUDIT ROW IS WRITTEN in the same transaction, with the structured
 *    from/to pairs in `metadata.changes` (AUDIT-2).
 *  - A GENUINELY SIGNED JOB — signed through the workflow, with its row in
 *    `job_signatures`, which is what `0007_signed_job_immutability.sql` keys
 *    off — is refused, and nothing on it moves: not the column, not the
 *    version, not the signature, and no audit row is written.
 *
 * Run with `npm run db:test`. Skipped where there is no `TEST_DATABASE_URL`.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

const PASSWORD = 'a-real-test-password';
const MASTER = 'elmarie@example-test.co.za';
const COORDINATOR = 'christene@example-test.co.za';
const TECHNICIAN = 'sipho@example-test.co.za';

describeDb('correcting a job’s details on PostgreSQL', () => {
  let db: Database;

  const signIn = async (email: string): Promise<ApiTestClient> => {
    const client = new ApiTestClient();
    const response = await client.signIn(email, PASSWORD);
    if (response.status !== 200) throw new Error(`sign-in failed for ${email}`);
    return client;
  };

  const raise = async (client: ApiTestClient, over: Record<string, unknown> = {}): Promise<Job> => {
    const created = await client.post<Job>('/api/jobs', {
      customerId: IDS.customer,
      siteId: IDS.site,
      contactId: IDS.contact,
      machineId: IDS.machine,
      jobType: 'breakdown',
      priority: 'urgent',
      scheduledDate: null,
      scheduledEndDate: null,
      orderNumber: 'PO-81000',
      referenceNumber: 'REF-1',
      faultDescription: 'Spindle drive alarm 750.',
      primaryTechnicianId: IDS.technician,
      courierCollection: false,
      deliveryNote: '',
      ...over,
    });
    expect(created.status, JSON.stringify(created.error)).toBe(200);
    return created.data;
  };

  const row = async (id: string) => {
    const [found] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
    return found!;
  };

  const editEvents = (id: string) =>
    db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.jobId, id), eq(schema.auditEvents.type, 'job_details_edited')));

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

  it('persists a Coordinator’s correction, moves the version, and writes the audit row', async () => {
    const master = await signIn(MASTER);
    const job = await raise(master);
    const versionBefore = (await row(job.id)).version;

    const coordinator = await signIn(COORDINATOR);
    const response = await coordinator.post<Job>(`/api/jobs/${job.id}/edit_details`, {
      changes: { orderNumber: '  PO-81000-A  ', faultDescription: 'Spindle drive alarm 750 on axis Z.' },
      expected: { orderNumber: 'PO-81000', faultDescription: 'Spindle drive alarm 750.' },
    });
    expect(response.status, JSON.stringify(response.error)).toBe(200);

    const stored = await row(job.id);
    expect(stored.orderNumber).toBe('PO-81000-A');
    expect(stored.faultDescription).toBe('Spindle drive alarm 750 on axis Z.');
    expect(stored.referenceNumber).toBe('REF-1');
    expect(stored.version).toBeGreaterThan(versionBefore);

    const events = await editEvents(job.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.actorId).toBe(IDS.coordinator);
    expect((events[0]!.metadata as { changes: unknown }).changes).toEqual([
      { field: 'details.orderNumber', from: 'PO-81000', to: 'PO-81000-A' },
      {
        field: 'details.faultDescription',
        from: 'Spindle drive alarm 750.',
        to: 'Spindle drive alarm 750 on axis Z.',
      },
    ]);
  });

  it('round trips the Test & Repair unit, including clearing a quantity back to NULL', async () => {
    const master = await signIn(MASTER);
    const job = await raise(master, {
      jobType: 'test_and_repair',
      machineId: null,
      priority: null,
      primaryTechnicianId: null,
      faultDescription: '',
      repairPartNumber: '',
      repairQuantity: 3,
    });

    const filled = await master.post<Job>(`/api/jobs/${job.id}/edit_details`, {
      changes: { repairPartNumber: '1FK7042-2AF71', repairQuantity: null, quoteNumber: 'Q-20451' },
      expected: { repairPartNumber: '', repairQuantity: 3, quoteNumber: '' },
    });
    expect(filled.status, JSON.stringify(filled.error)).toBe(200);

    const stored = await row(job.id);
    expect(stored.repairPartNumber).toBe('1FK7042-2AF71');
    expect(stored.repairQuantity).toBeNull();
    expect(stored.quoteNumber).toBe('Q-20451');
  });

  it('refuses a stale edit and keeps the value written first', async () => {
    const master = await signIn(MASTER);
    const job = await raise(master);
    const coordinator = await signIn(COORDINATOR);

    const first = await master.post(`/api/jobs/${job.id}/edit_details`, {
      changes: { orderNumber: 'PO-FIRST' },
      expected: { orderNumber: 'PO-81000' },
    });
    expect(first.status).toBe(200);

    const second = await coordinator.post(`/api/jobs/${job.id}/edit_details`, {
      changes: { orderNumber: 'PO-SECOND' },
      expected: { orderNumber: 'PO-81000' },
    });
    expect(second.status).toBe(422);
    expect((await row(job.id)).orderNumber).toBe('PO-FIRST');
    expect(await editEvents(job.id)).toHaveLength(1);
  });

  it('refuses a technician with 403 and writes nothing', async () => {
    const master = await signIn(MASTER);
    const job = await raise(master);
    const tech = await signIn(TECHNICIAN);
    const response = await tech.post(`/api/jobs/${job.id}/edit_details`, {
      changes: { orderNumber: 'PO-TECH' },
      expected: { orderNumber: 'PO-81000' },
    });
    expect(response.status).toBe(403);
    expect((await row(job.id)).orderNumber).toBe('PO-81000');
    expect(await editEvents(job.id)).toHaveLength(0);
  });

  it('refuses a GENUINELY SIGNED job, and nothing on it moves', async () => {
    const master = await signIn(MASTER);
    const job = await raise(master);
    const tech = await signIn(TECHNICIAN);
    const id = job.id;

    expect((await tech.post(`/api/jobs/${id}/accept`)).status).toBe(200);
    expect(
      (
        await tech.post(`/api/jobs/${id}/add_labour`, {
          date: '2026-09-17',
          rateType: 'normal',
          hours: 3,
          description: 'Replaced the coolant pump.',
        })
      ).status,
    ).toBe(200);
    await tech.post(`/api/jobs/${id}/save_report`, {
      faultFindings: '',
      diagnosis: '',
      workPerformed: 'Replaced the coolant pump and cleared the alarm.',
      recommendations: '',
      generalNotes: '',
    });
    await tech.post(`/api/jobs/${id}/start_completion`);
    await tech.post(`/api/jobs/${id}/start_signature`);
    const signed = await tech.post<Job>(`/api/jobs/${id}/capture_signature`, {
      customerName: 'Pieter',
      customerSurname: 'Nel',
      strokeData: 'M0,0 L1,1',
    });
    expect(signed.status, JSON.stringify(signed.error)).toBe(200);

    // The signature is really in the table — the immutability triggers key off
    // this row, so a test without it would prove nothing.
    const signatureRows = await db
      .select()
      .from(schema.jobSignatures)
      .where(eq(schema.jobSignatures.jobId, id));
    expect(signatureRows).toHaveLength(1);

    const before = await row(id);
    const refused = await master.post(`/api/jobs/${id}/edit_details`, {
      changes: { orderNumber: 'PO-AFTER-SIGNING', faultDescription: 'Rewritten after signing.' },
      expected: { orderNumber: 'PO-81000', faultDescription: 'Spindle drive alarm 750.' },
    });
    expect(refused.status).toBe(422);

    const after = await row(id);
    expect(after.orderNumber).toBe(before.orderNumber);
    expect(after.faultDescription).toBe(before.faultDescription);
    expect(after.version).toBe(before.version);
    expect(
      await db.select().from(schema.jobSignatures).where(eq(schema.jobSignatures.jobId, id)),
    ).toEqual(signatureRows);
    expect(await editEvents(id)).toHaveLength(0);
  });
});
