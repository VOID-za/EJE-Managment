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
 * Job creation, assignment and acceptance ON REAL POSTGRESQL.
 *
 * WHAT THIS ADDS over the demonstration-store tests. Those prove the rules; the
 * demonstration store cannot prove that any of it PERSISTS — it has no
 * transaction, no foreign keys, no rows to go looking for afterwards. Here the
 * assertions are made against the tables: the job row, the technician rows, the
 * attachment rows, the notification row and the audit rows, read back with
 * Drizzle rather than taken from the API's own answer.
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

describeDb('job creation and assignment on PostgreSQL', () => {
  let db: Database;

  const signIn = async (email: string): Promise<ApiTestClient> => {
    const client = new ApiTestClient();
    const response = await client.signIn(email, PASSWORD);
    if (response.status !== 200) {
      throw new Error(`sign-in failed for ${email}: ${response.error?.message ?? ''}`);
    }
    return client;
  };

  const raise = (client: ApiTestClient, over: Record<string, unknown> = {}) =>
    client.post<Job>('/api/jobs', {
      customerId: IDS.customer,
      siteId: IDS.site,
      contactId: IDS.contact,
      machineId: IDS.machine,
      jobType: 'breakdown',
      priority: 'urgent',
      scheduledDate: null,
      scheduledEndDate: null,
      orderNumber: 'PO-77120',
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
    await db.update(schema.users).set({ passwordHash: await hashPassword(PASSWORD) });
    startPostgresTestServer(url ?? '');
  });

  /*
   * THE PARTS COLLECTION SHAPE, AGAINST THE REAL SCHEMA. MASTER SCOPE CR-12/13.
   *
   * The claim being tested is that NO MIGRATION IS REQUIRED: a collection is a
   * job row with `status = 'completion'`, no technician, no scheduled date and
   * an empty description, and every one of those columns already allows it —
   * `scheduled_date date` and `primary_technician_id uuid` are nullable,
   * `fault_description` is `text DEFAULT '' NOT NULL`, and `completion` is
   * already in the `job_status` enum. Reading it back from the table is what
   * turns that from a reading of the DDL into a fact.
   */
  it('persists a parts collection with no technician, date or description', async () => {
    const master = await signIn(EMAILS.master);
    const created = await raise(master, {
      jobType: 'parts',
      machineId: null,
      orderNumber: 'PO-PARTS-01',
      deliveryNote: 'DN-1',
      // Sent deliberately: the server decides all three, whatever is asked for.
      priority: 'urgent',
      scheduledDate: '2026-09-28',
      faultDescription: 'ignored on a collection',
    });
    expect(created.status).toBe(200);

    const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, created.data.id));
    expect(row?.status).toBe('completion');
    expect(row?.primaryTechnicianId).toBeNull();
    expect(row?.scheduledDate).toBeNull();
    expect(row?.faultDescription).toBe('');
    expect(row?.priority).toBe('normal');
    expect(row?.courierCollection).toBe(false);

    // And no technician rows were written for it.
    const participants = await db
      .select()
      .from(schema.jobTechnicians)
      .where(eq(schema.jobTechnicians.jobId, created.data.id));
    expect(participants).toHaveLength(0);
  });

  it('refuses acceptance of a parts collection over the real API', async () => {
    const master = await signIn(EMAILS.master);
    const created = await raise(master, {
      jobType: 'parts',
      machineId: null,
      orderNumber: 'PO-PARTS-02',
    });
    expect(created.status).toBe(200);

    const accepted = await master.post(`/api/jobs/${created.data.id}/accept`, {});
    expect(accepted.status).toBe(403);

    // The row is untouched: no status change, no acceptance stamp.
    const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, created.data.id));
    expect(row?.status).toBe('completion');
    expect(row?.acceptedAt).toBeNull();
  });

  it('writes the job, its technicians and its attachments as rows', async () => {
    const master = await signIn(EMAILS.master);
    const created = await raise(master, {
      primaryTechnicianId: IDS.technician,
      additionalTechnicianIds: [IDS.otherTechnician],
    });
    expect(created.status).toBe(200);

    // The document goes up separately, because a JSON creation request carries
    // no bytes and an attachment with no bytes is the fiction being removed.
    const uploaded = await master.upload(`/api/jobs/${created.data.id}/attachments`, {
      name: 'order-77120.pdf',
      type: 'application/pdf',
      bytes: new TextEncoder().encode('%PDF-1.4 the order'),
    });
    expect(uploaded.status).toBe(200);

    const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, created.data.id));
    expect(row?.status).toBe('open');
    expect(row?.createdBy).toBe(IDS.master);
    // Created is not started, in the table as well as in the answer.
    expect(row?.acceptedAt).toBeNull();

    // The primary is a column on the job; `job_technicians` carries the
    // assistants. Two different facts, stored as two different things.
    expect(row?.primaryTechnicianId).toBe(IDS.technician);

    const assistants = await db
      .select()
      .from(schema.jobTechnicians)
      .where(eq(schema.jobTechnicians.jobId, created.data.id));
    expect(assistants.map((entry) => entry.userId)).toEqual([IDS.otherTechnician]);

    /*
     * And the participation rows DECISION 5 reads.
     *
     * Written at creation, not only on transfer: a technician assigned today
     * and reassigned tomorrow keeps access to the work they did, and that is
     * only true if being assigned opened a participation row in the first
     * place.
     */
    const participants = await db
      .select()
      .from(schema.jobParticipants)
      .where(eq(schema.jobParticipants.jobId, created.data.id));
    expect(participants.map((entry) => entry.userId).sort()).toEqual(
      [IDS.technician, IDS.otherTechnician].sort(),
    );

    const media = await db
      .select()
      .from(schema.jobMedia)
      .where(eq(schema.jobMedia.jobId, created.data.id));
    expect(media).toHaveLength(1);
    expect(media[0]?.kind).toBe('document');
    expect(media[0]?.fileName).toBe('order-77120.pdf');
    expect(media[0]?.uploadedBy).toBe(IDS.master);
    // The row locates the object; the bytes are not duplicated into PostgreSQL.
    expect(media[0]?.storageKey).toMatch(/^uploads\//u);
  });

  it('writes the assignment notification as a row the technician can read', async () => {
    const master = await signIn(EMAILS.master);
    const created = await raise(master, { primaryTechnicianId: IDS.technician });

    const notifications = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.recipientId, IDS.technician));

    const raised = notifications.filter((item) => item.jobId === created.data.id);
    expect(raised).toHaveLength(1);
    expect(raised[0]?.type).toBe('job_assigned');
  });

  /**
   * THE RELATIONSHIPS, against a database that would happily store any of it.
   *
   * Every id below is a real row. A foreign key is satisfied by all of them —
   * which is exactly why the check cannot be left to the database.
   */
  it('refuses a site belonging to another customer, and writes nothing', async () => {
    const master = await signIn(EMAILS.master);
    const response = await raise(master, {
      siteId: IDS.otherSite,
      machineId: null,
      jobType: 'parts',
    });

    expect(response.status).toBe(422);
    expect((response.error?.violations ?? []).map((violation) => violation.code)).toContain(
      'site_not_of_customer',
    );
    expect(await db.select().from(schema.jobs)).toHaveLength(0);
  });

  it('refuses a machine belonging to another customer', async () => {
    const master = await signIn(EMAILS.master);
    const response = await raise(master, { machineId: IDS.otherMachine });

    expect(response.status).toBe(422);
    expect(await db.select().from(schema.jobs)).toHaveLength(0);
  });

  it('refuses a recipient at another customer', async () => {
    const master = await signIn(EMAILS.master);
    const response = await raise(master, { contactId: IDS.otherContact });

    expect(response.status).toBe(422);
    expect(await db.select().from(schema.jobs)).toHaveLength(0);
  });

  it('consumes no job number on a refusal, so the sequence has no gap', async () => {
    const master = await signIn(EMAILS.master);

    const first = await raise(master);
    expect(first.status).toBe(200);

    await raise(master, { machineId: IDS.otherMachine, orderNumber: 'PO-77121' });

    const second = await raise(master, { orderNumber: 'PO-77122' });
    expect(second.status).toBe(200);

    // Consecutive. A gap in EJE's job numbers is a question somebody has to
    // answer, and a refused request must not create one.
    const firstNumber = Number(first.data.jobNumber.split('-')[1]);
    const secondNumber = Number(second.data.jobNumber.split('-')[1]);
    expect(secondNumber).toBe(firstNumber + 1);
  });

  it('refuses a technician raising a job, over the real API', async () => {
    const technician = await signIn(EMAILS.technician);
    expect((await raise(technician)).status).toBe(403);
    expect(await db.select().from(schema.jobs)).toHaveLength(0);
  });

  it('accepts the job and commits the status, the time and the audit together', async () => {
    const master = await signIn(EMAILS.master);
    const created = await raise(master, { primaryTechnicianId: IDS.technician });

    const technician = await signIn(EMAILS.technician);
    const accepted = await technician.post<Job>(`/api/jobs/${created.data.id}/accept`);
    expect(accepted.status).toBe(200);

    const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, created.data.id));
    expect(row?.status).toBe('in_progress');
    expect(row?.acceptedAt).not.toBeNull();

    const events = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.jobId, created.data.id));
    const types = events.map((event) => event.type);

    expect(types).toContain('job_created');
    expect(types).toContain('job_assigned');
    expect(types).toContain('job_accepted');
    // The integration attempt is recorded either way it went. On this
    // deployment WhatsApp is unconfigured, so it is the failure that is
    // recorded — which is the honest answer, not a missing one.
    expect(
      types.includes('assignment_notified') || types.includes('assignment_notification_failed'),
    ).toBe(true);
  });

  it('refuses a technician accepting a job assigned to somebody else', async () => {
    const master = await signIn(EMAILS.master);
    const created = await raise(master, { primaryTechnicianId: IDS.technician });

    const other = await signIn(EMAILS.otherTechnician);
    const response = await other.post(`/api/jobs/${created.data.id}/accept`);

    // 404: a job they may not see does not exist as far as they are concerned.
    expect(response.status).toBe(404);

    const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, created.data.id));
    expect(row?.status).toBe('open');
    expect(row?.acceptedAt).toBeNull();
  });

  it('performs a repeated acceptance once under one idempotency key', async () => {
    const master = await signIn(EMAILS.master);
    const created = await raise(master, { primaryTechnicianId: IDS.technician });
    const technician = await signIn(EMAILS.technician);
    const key = 'db-accept-once';

    const first = await technician.post<Job>(`/api/jobs/${created.data.id}/accept`, undefined, {
      idempotencyKey: key,
    });
    const retry = await technician.post<Job>(`/api/jobs/${created.data.id}/accept`, undefined, {
      idempotencyKey: key,
    });

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);

    // One acceptance, one audit event, whatever the network did.
    const events = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.jobId, created.data.id));
    expect(events.filter((event) => event.type === 'job_accepted')).toHaveLength(1);
  });

  it('refuses a Coordinator accepting field work, and leaves the job Open', async () => {
    const master = await signIn(EMAILS.master);
    const created = await raise(master);

    const coordinator = await signIn(EMAILS.coordinator);
    expect((await coordinator.post(`/api/jobs/${created.data.id}/accept`)).status).toBe(403);

    const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, created.data.id));
    expect(row?.status).toBe('open');
  });

  it('serves the accepted job’s customer information to the technician', async () => {
    const master = await signIn(EMAILS.master);
    const created = await raise(master, { primaryTechnicianId: IDS.technician });
    const technician = await signIn(EMAILS.technician);
    await technician.post(`/api/jobs/${created.data.id}/accept`);

    const view = await technician.get<{
      view: {
        customer: { name: string };
        site: { name: string };
        contact: { email: string } | null;
      };
    }>(`/api/jobs/${created.data.jobNumber}`);

    expect(view.status).toBe(200);
    expect(view.data.view.customer.name).toBe('ABC Engineering');
    expect(view.data.view.site.name).toBe('Isando');
    expect(view.data.view.contact?.email).toBe('pieter@example-test.co.za');
  });
});
