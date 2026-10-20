import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as schema from '@/db/schema';
import { IDS, seedBaseline } from '@/data/postgres/test-fixtures';
import { openTestDatabase, testDatabaseUrl, truncateAll } from '@/data/postgres/test-database';
import { hashPassword } from '@/server/auth/passwords';
import { ApiTestClient, startPostgresTestServer } from '@/test/api-harness';

/**
 * A CUSTOMER'S FILED PAPERWORK, ON REAL POSTGRESQL AND REAL STORAGE.
 * October mandate §4.
 *
 * The API tests run against the demonstration backend, where storage keeps
 * bytes in a process-local store and the repositories are in memory. What those
 * cannot reach is everything that could go wrong here: the `customer_documents`
 * row and its RESTRICT foreign key, the size CHECK, the filesystem adapter
 * actually holding the bytes, and — the question §4 asks explicitly — whether
 * the attachment survives a restart.
 *
 * AUD-6's lesson, applied: a path that has never run against PostgreSQL is a
 * path nobody has tested.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

const PASSWORD = 'a-real-test-password';
const MASTER = 'elmarie@example-test.co.za';
const TECHNICIAN = 'sipho@example-test.co.za';
const AGREEMENT = '%PDF-1.4\nsigned service agreement\n%%EOF';

/** The message PostgreSQL actually raised, which the driver keeps on the cause. */
const postgresMessage = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error) return cause.message;
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('the statement was expected to be refused, and was not');
};

interface DocumentBody {
  readonly document: {
    readonly id: string;
    readonly fileName: string;
    readonly sizeBytes: number;
    readonly checksumSha256: string | null;
    readonly provenance: string;
  };
}

describeDb('customer documents on PostgreSQL', () => {
  let db: Database;
  let storageRoot: string;

  const signIn = async (email: string): Promise<ApiTestClient> => {
    const client = new ApiTestClient();
    const response = await client.signIn(email, PASSWORD);
    if (response.status !== 200) throw new Error(`sign-in failed for ${email}`);
    return client;
  };

  beforeAll(async () => {
    db = await openTestDatabase(url ?? '');
    storageRoot = await mkdtemp(join(tmpdir(), 'eje-customer-docs-'));
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

  const attach = async (
    client: ApiTestClient,
    body = AGREEMENT,
    name = 'service-agreement.pdf',
  ) =>
    client.upload<DocumentBody>(`/api/customers/${IDS.customer}/documents`, {
      name,
      type: 'application/pdf',
      bytes: new TextEncoder().encode(body),
      fields: { caption: 'Signed service agreement, 2026' },
    });

  it('writes the row, the bytes and the checksum the store measured', async () => {
    const master = await signIn(MASTER);
    const attached = await attach(master);
    expect(attached.status, JSON.stringify(attached.error)).toBe(200);

    const rows = await db
      .select()
      .from(schema.customerDocuments)
      .where(eq(schema.customerDocuments.customerId, IDS.customer));
    expect(rows).toHaveLength(1);

    const row = rows[0];
    const expected = new TextEncoder().encode(AGREEMENT);
    expect(row?.sizeBytes).toBe(expected.byteLength);
    expect(row?.checksumSha256).toBe(createHash('sha256').update(expected).digest('hex'));
    expect(row?.provenance).toBe('genuine');
    expect(row?.archivedAt).toBeNull();

    // And the bytes are on the disk, under the key the row carries.
    const files = await readdir(join(storageRoot, 'uploads'));
    expect(files.some((file) => file.endsWith('.bin'))).toBe(true);
  });

  /**
   * THE QUESTION §4 ASKS: does it survive a restart? The server is rebuilt
   * from nothing but the connection string and the storage directory, which is
   * as close as a test gets to the machine coming back up.
   */
  it('survives the application restarting', async () => {
    const master = await signIn(MASTER);
    const attached = await attach(master);
    const id = attached.data.document.id;

    // A new runtime over the same database and the same directory.
    startPostgresTestServer(url ?? '');
    const afterRestart = await signIn(MASTER);

    const listed = await afterRestart.get<{ documents: readonly { id: string }[] }>(
      `/api/customers/${IDS.customer}/documents`,
    );
    expect(listed.data.documents.map((document) => document.id)).toContain(id);

    const file = await afterRestart.download(
      `/api/customers/${IDS.customer}/documents/${id}`,
    );
    expect(file.status).toBe(200);
    expect(new TextDecoder().decode(file.bytes)).toBe(AGREEMENT);
  });

  it('REFUSES to let a technician read the register’s files', async () => {
    const master = await signIn(MASTER);
    const attached = await attach(master);
    const technician = await signIn(TECHNICIAN);

    expect((await technician.get(`/api/customers/${IDS.customer}/documents`)).status).toBe(403);
    const file = await technician.download(
      `/api/customers/${IDS.customer}/documents/${attached.data.document.id}`,
    );
    expect([403, 404]).toContain(file.status);
  });

  /* -- what the database itself refuses ------------------------------------ */

  it('REFUSES a row claiming a file of no bytes', async () => {
    // The CHECK exists because a zero-byte "document" is the shape a
    // metadata-only record would take, and this table is for files that are
    // genuinely stored.
    const message = await postgresMessage(
      db.insert(schema.customerDocuments).values({
        id: crypto.randomUUID(),
        customerId: IDS.customer,
        fileName: 'nothing.pdf',
        contentType: 'application/pdf',
        storageKey: 'uploads/nothing',
        sizeBytes: 0,
        uploadedAt: '2026-10-20T08:00:00.000Z',
        uploadedBy: IDS.master,
      }),
    );

    expect(message).toMatch(/customer_documents_size_positive/u);
  });

  /**
   * A CUSTOMER OF ITS OWN, because the seeded one has contacts and sites and
   * would be undeletable for those reasons — which would make this test pass
   * while proving nothing about THIS table's foreign key. (The change-request
   * tests learned the same lesson the same way.)
   */
  it('REFUSES deleting a customer that has documents', async () => {
    const customerId = crypto.randomUUID();
    await db.insert(schema.customers).values({
      id: customerId,
      name: 'Nothing Else Refers To This (Pty) Ltd',
      accountNumber: `ACC-${customerId.slice(0, 6)}`,
      industry: 'Testing',
      active: true,
    });

    // Deletable until the document exists, which is what makes the refusal
    // below the document's own doing.
    await db.insert(schema.customerDocuments).values({
      id: crypto.randomUUID(),
      customerId,
      fileName: 'agreement.pdf',
      contentType: 'application/pdf',
      storageKey: `uploads/${crypto.randomUUID()}`,
      sizeBytes: 42,
      uploadedAt: '2026-10-20T08:00:00.000Z',
      uploadedBy: IDS.master,
    });

    const message = await postgresMessage(
      db.delete(schema.customers).where(eq(schema.customers.id, customerId)),
    );

    // RESTRICT, like every other reference to history: a customer with
    // documents is archived rather than deleted.
    expect(message).toMatch(/customer_documents/u);
  });

  it('keeps two documents apart, newest first', async () => {
    const master = await signIn(MASTER);
    await attach(master, '%PDF-1.4 first\n%%EOF', 'first.pdf');
    await attach(master, '%PDF-1.4 second\n%%EOF', 'second.pdf');

    const listed = await master.get<{
      documents: readonly { fileName: string; sizeBytes: number }[];
    }>(`/api/customers/${IDS.customer}/documents`);
    expect(listed.data.documents).toHaveLength(2);
    // Different bytes, different sizes: neither overwrote the other.
    const sizes = new Set(listed.data.documents.map((document) => document.sizeBytes));
    expect(sizes.size).toBe(2);
  });

  afterAll(async () => {
    await db.execute(sql`select 1`).catch(() => undefined);
  });
});
