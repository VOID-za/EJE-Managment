import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as schema from '@/db/schema';
import type { Job } from '@/domain';
import { IDS, seedBaseline } from '@/data/postgres/test-fixtures';
import { openTestDatabase, testDatabaseUrl, truncateAll } from '@/data/postgres/test-database';
import { hashPassword } from '@/server/auth/passwords';
import { ApiTestClient, startPostgresTestServer } from '@/test/api-harness';
import { getServerRuntime } from '@/server/runtime';
import { dispatchOutbox } from './outbox-dispatch';

/**
 * DURABLE STORAGE AND THE OUTBOX, on real PostgreSQL with a real directory.
 *
 * WHAT ONLY THIS CAN SHOW. The demonstration store proves the rules; it cannot
 * prove that an attachment's bytes are on a disk, that the row locating them is
 * in a table, or that the message waiting to be sent survives the transaction
 * that promised it. All three are asserted here against the things themselves.
 *
 * Run with `npm run db:test`. Skipped where there is no `TEST_DATABASE_URL`.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

const PASSWORD = 'a-real-test-password';
const MASTER = 'elmarie@example-test.co.za';

const PDF = new TextEncoder().encode('%PDF-1.4 the customer order');

describeDb('durable storage and the outbox on PostgreSQL', () => {
  let db: Database;
  let storageRoot: string;

  const signIn = async (email: string): Promise<ApiTestClient> => {
    const client = new ApiTestClient();
    const response = await client.signIn(email, PASSWORD);
    if (response.status !== 200) throw new Error(`sign-in failed for ${email}`);
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
      orderNumber: 'PO-81000',
      referenceNumber: '',
      faultDescription: 'Spindle drive alarm 750.',
      primaryTechnicianId: null,
      courierCollection: false,
      deliveryNote: '',
      ...over,
    });

  beforeAll(async () => {
    db = await openTestDatabase(url ?? '');
    // A REAL DIRECTORY. The whole claim being tested is that bytes land on a
    // filesystem and can be found again, so nothing here is in memory.
    storageRoot = await mkdtemp(join(tmpdir(), 'eje-db-storage-'));
    process.env.EJE_STORAGE_DIR = storageRoot;
    startPostgresTestServer(url ?? '');
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await rm(storageRoot, { recursive: true, force: true });
    delete process.env.EJE_STORAGE_DIR;
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seedBaseline(db);
    await db.update(schema.users).set({ passwordHash: await hashPassword(PASSWORD) });
    process.env.EJE_STORAGE_DIR = storageRoot;
    startPostgresTestServer(url ?? '');
  });

  /* ---------------------------------------------------------------------- */
  /* Storage                                                                */
  /* ---------------------------------------------------------------------- */

  it('writes the bytes to disk and the index row to PostgreSQL', async () => {
    const master = await signIn(MASTER);
    const job = await raise(master);

    const uploaded = await master.upload<{ attachments: readonly { id: string }[] }>(
      `/api/jobs/${job.data.id}/attachments`,
      { name: 'customer-order.pdf', type: 'application/pdf', bytes: PDF },
    );
    expect(uploaded.status).toBe(200);

    const media = await db
      .select()
      .from(schema.jobMedia)
      .where(eq(schema.jobMedia.jobId, job.data.id));

    expect(media).toHaveLength(1);
    expect(media[0]?.kind).toBe('document');
    expect(media[0]?.sizeBytes).toBe(PDF.length);
    /*
     * THE DATABASE IS THE INDEX, NOT THE STORE.
     *
     * The row says where the object is; it does not contain it. Nothing in this
     * table holds the file's contents, which is what keeps PostgreSQL a
     * database rather than a filesystem with extra steps.
     */
    expect(media[0]?.storageKey).toMatch(/^uploads\/[0-9a-f-]{36}$/u);
  });

  it('serves the file back after the application has been restarted', async () => {
    const master = await signIn(MASTER);
    const job = await raise(master);
    const uploaded = await master.upload<{ attachments: readonly { id: string }[] }>(
      `/api/jobs/${job.data.id}/attachments`,
      { name: 'customer-order.pdf', type: 'application/pdf', bytes: PDF },
    );
    const attachmentId = uploaded.data.attachments[0]?.id ?? '';

    /*
     * THE RESTART.
     *
     * Everything the process was holding is thrown away and rebuilt: a new
     * runtime, new repositories, a new storage adapter. Only the database and
     * the directory survive — which is the definition being tested.
     */
    startPostgresTestServer(url ?? '');

    const after = await signIn(MASTER);
    const download = await after.download(
      `/api/jobs/${job.data.id}/attachments/${attachmentId}`,
    );

    expect(download.status).toBe(200);
    expect(Array.from(download.bytes)).toEqual(Array.from(PDF));
  });

  it('records nothing when the bytes could not be stored', async () => {
    const master = await signIn(MASTER);
    const job = await raise(master);

    // A store that cannot be written to. The database must not end up claiming
    // an attachment exists when nothing was written.
    process.env.EJE_STORAGE_DIR = join(storageRoot, 'blocked-by-a-file', 'store');
    startPostgresTestServer(url ?? '');
    const retry = await signIn(MASTER);

    // Make the parent a FILE so the directory cannot be created.
    await rm(join(storageRoot, 'blocked-by-a-file'), { recursive: true, force: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(storageRoot, 'blocked-by-a-file'), 'not a directory');

    const response = await retry.upload(`/api/jobs/${job.data.id}/attachments`, {
      name: 'order.pdf',
      type: 'application/pdf',
      bytes: PDF,
    });

    expect(response.status).toBe(500);

    const media = await db
      .select()
      .from(schema.jobMedia)
      .where(eq(schema.jobMedia.jobId, job.data.id));
    // THE POINT: no row. A failed write leaves the database saying nothing
    // rather than pointing at a file that was never created.
    expect(media).toHaveLength(0);
  });

  it('refuses a file whose bytes are not what its name claims', async () => {
    const master = await signIn(MASTER);
    const job = await raise(master);

    const response = await master.upload(`/api/jobs/${job.data.id}/attachments`, {
      name: 'invoice.pdf',
      type: 'application/pdf',
      bytes: new Uint8Array([0x4d, 0x5a, 0x90, 0x00]),
    });

    expect(response.status).toBe(400);
    expect(
      await db.select().from(schema.jobMedia).where(eq(schema.jobMedia.jobId, job.data.id)),
    ).toHaveLength(0);
  });

  it('refuses the file to somebody who may not read the job', async () => {
    const master = await signIn(MASTER);
    const job = await raise(master, { primaryTechnicianId: IDS.technician });
    const uploaded = await master.upload<{ attachments: readonly { id: string }[] }>(
      `/api/jobs/${job.data.id}/attachments`,
      { name: 'order.pdf', type: 'application/pdf', bytes: PDF },
    );

    const other = await signIn('lerato@example-test.co.za');
    const response = await other.download(
      `/api/jobs/${job.data.id}/attachments/${uploaded.data.attachments[0]?.id ?? ''}`,
    );

    expect(response.status).toBe(404);
  });

  /* ---------------------------------------------------------------------- */
  /* The outbox                                                             */
  /* ---------------------------------------------------------------------- */

  it('commits the message to send with the assignment that created it', async () => {
    const master = await signIn(MASTER);
    const job = await raise(master, { primaryTechnicianId: IDS.technician });

    const rows = await db
      .select()
      .from(schema.outboxMessages)
      .where(eq(schema.outboxMessages.jobId, job.data.id));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.channel).toBe('whatsapp');
    expect(rows[0]?.template).toBe('eje_job_assigned');
  });

  it('leaves it pending on a deployment with no WhatsApp configured', async () => {
    /*
     * The honest outcome, and the one that matters most.
     *
     * PostgreSQL with no credentials gets `UnconfiguredWhatsAppService`, which
     * refuses. The row stays PENDING with the reason on it — so the obligation
     * survives, and nothing anywhere claims a message went.
     */
    const master = await signIn(MASTER);
    const job = await raise(master, { primaryTechnicianId: IDS.technician });

    const [row] = await db
      .select()
      .from(schema.outboxMessages)
      .where(eq(schema.outboxMessages.jobId, job.data.id));

    expect(row?.state).toBe('pending');
    expect(row?.attempts).toBeGreaterThan(0);
    expect(row?.failureReason).toContain('not configured');
    expect(row?.providerMessageId).toBeNull();
  });

  it('retries the same message rather than creating a second business change', async () => {
    const master = await signIn(MASTER);
    const job = await raise(master, { primaryTechnicianId: IDS.technician });

    const before = await db
      .select()
      .from(schema.outboxMessages)
      .where(eq(schema.outboxMessages.jobId, job.data.id));

    await dispatchOutbox(getServerRuntime());

    const after = await db
      .select()
      .from(schema.outboxMessages)
      .where(eq(schema.outboxMessages.jobId, job.data.id));

    // ONE row throughout: a retry is another attempt at the same obligation,
    // never a new one. And the job was not assigned twice either.
    expect(after).toHaveLength(1);
    expect(after[0]?.attempts).toBe((before[0]?.attempts ?? 0) + 1);

    const [jobRow] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, job.data.id));
    expect(jobRow?.primaryTechnicianId).toBe(IDS.technician);
  });

  it('stops trying after the attempt limit, and says why', async () => {
    const master = await signIn(MASTER);
    const job = await raise(master, { primaryTechnicianId: IDS.technician });

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await dispatchOutbox(getServerRuntime());
    }

    const [row] = await db
      .select()
      .from(schema.outboxMessages)
      .where(eq(schema.outboxMessages.jobId, job.data.id));

    expect(row?.state).toBe('failed');
    expect(row?.failureReason.length).toBeGreaterThan(0);
  });

  it('assigns the job successfully even though the message cannot be sent', async () => {
    const master = await signIn(MASTER);
    const response = await raise(master, { primaryTechnicianId: IDS.technician });

    // The provider being unreachable is not the assigning person's problem and
    // must never become an error on their screen.
    expect(response.status).toBe(200);
    expect(response.data.primaryTechnicianId).toBe(IDS.technician);

    const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, response.data.id));
    expect(row?.status).toBe('open');
  });
});
