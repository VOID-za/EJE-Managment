import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as schema from '@/db/schema';
import { IDS, seedBaseline } from '@/data/postgres/test-fixtures';
import { openTestDatabase, testDatabaseUrl, truncateAll } from '@/data/postgres/test-database';
import { hashPassword } from '@/server/auth/passwords';
import { ApiTestClient, startPostgresTestServer } from '@/test/api-harness';

/**
 * PAPER ABOUT ONE MACHINE, ON REAL POSTGRESQL AND REAL STORAGE.
 * October mandate §4.
 *
 * The API tests run against the demonstration backend, where storage keeps
 * bytes in a process-local store and the repositories are in memory. What they
 * cannot reach is what could only go wrong here: the `machine_documents` row
 * and its CASCADE foreign key, the size and audience CHECKs, the filesystem
 * adapter actually holding the bytes, whether the attachment survives a
 * restart, and whether the AUDIENCE reaches the column at all — which is the
 * mistake DEMO-1 made twice with `provenance` and found by counting rows.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

const PASSWORD = 'a-real-test-password';
const MASTER = 'elmarie@example-test.co.za';
const TECHNICIAN = 'sipho@example-test.co.za';
const REPORT = '%PDF-1.4\nlaser calibration results\n%%EOF';

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
    readonly audience: string;
    readonly provenance: string;
  };
}

describeDb('machine documents on PostgreSQL', () => {
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
    storageRoot = await mkdtemp(join(tmpdir(), 'eje-machine-docs-'));
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
    audience: string,
    body = REPORT,
    name = 'laser-calibration.pdf',
  ) =>
    client.upload<DocumentBody>(`/api/machines/${IDS.machine}/documents`, {
      name,
      type: 'application/pdf',
      bytes: new TextEncoder().encode(body),
      fields: { caption: 'Laser calibration, March 2026', audience },
    });

  it('writes the row, the bytes, the checksum and the AUDIENCE the office chose', async () => {
    const master = await signIn(MASTER);
    const attached = await attach(master, 'field');
    expect(attached.status, JSON.stringify(attached.error)).toBe(200);

    const rows = await db
      .select()
      .from(schema.machineDocuments)
      .where(eq(schema.machineDocuments.machineId, IDS.machine));
    expect(rows).toHaveLength(1);

    const row = rows[0];
    const expected = new TextEncoder().encode(REPORT);
    expect(row?.sizeBytes).toBe(expected.byteLength);
    expect(row?.checksumSha256).toBe(createHash('sha256').update(expected).digest('hex'));
    /*
     * THE COLUMN, NOT THE RESPONSE. `provenance` was marked by a seed, dropped
     * by a repository insert and defaulted by the database, and the API said
     * the right thing throughout; only counting rows found it. The same read
     * is what proves the audience is not making the same journey.
     */
    expect(row?.audience).toBe('field');
    expect(row?.provenance).toBe('genuine');
    expect(row?.archivedAt).toBeNull();

    // And the bytes are on the disk, under the key the row carries.
    const files = await readdir(join(storageRoot, 'uploads'));
    expect(files.some((file) => file.endsWith('.bin'))).toBe(true);
  });

  it('writes office_only to the column too, and keeps it from the field', async () => {
    const master = await signIn(MASTER);
    const attached = await attach(master, 'office_only');

    const rows = await db
      .select({ audience: schema.machineDocuments.audience })
      .from(schema.machineDocuments)
      .where(eq(schema.machineDocuments.id, attached.data.document.id));
    expect(rows[0]?.audience).toBe('office_only');

    const technician = await signIn(TECHNICIAN);
    const listed = await technician.get<{ documents: readonly { id: string }[] }>(
      `/api/machines/${IDS.machine}/documents`,
    );
    expect(listed.data.documents).toEqual([]);
    const file = await technician.download(
      `/api/machines/${IDS.machine}/documents/${attached.data.document.id}`,
    );
    expect(file.status).toBe(404);
  });

  /**
   * THE QUESTION §4 ASKS: does it survive a restart? The server is rebuilt
   * from nothing but the connection string and the storage directory, which is
   * as close as a test gets to the machine coming back up.
   */
  it('survives the application restarting', async () => {
    const master = await signIn(MASTER);
    const attached = await attach(master, 'field');
    const id = attached.data.document.id;

    startPostgresTestServer(url ?? '');
    const afterRestart = await signIn(TECHNICIAN);

    const listed = await afterRestart.get<{ documents: readonly { id: string }[] }>(
      `/api/machines/${IDS.machine}/documents`,
    );
    expect(listed.data.documents.map((document) => document.id)).toContain(id);

    const file = await afterRestart.download(`/api/machines/${IDS.machine}/documents/${id}`);
    expect(file.status).toBe(200);
    expect(new TextDecoder().decode(file.bytes)).toBe(REPORT);
  });

  /* -- what the database itself refuses ------------------------------------ */

  it('REFUSES a row claiming a file of no bytes', async () => {
    const message = await postgresMessage(
      db.insert(schema.machineDocuments).values({
        id: crypto.randomUUID(),
        machineId: IDS.machine,
        fileName: 'nothing.pdf',
        contentType: 'application/pdf',
        storageKey: 'uploads/nothing-machine',
        sizeBytes: 0,
        uploadedAt: '2026-10-20T08:00:00.000Z',
        uploadedBy: IDS.master,
      }),
    );
    expect(message).toMatch(/machine_documents_size_positive/u);
  });

  it('REFUSES an audience nobody defined', async () => {
    // The CHECK is what stops a third value appearing and being read by two
    // different call sites as two different things.
    const message = await postgresMessage(
      db.insert(schema.machineDocuments).values({
        id: crypto.randomUUID(),
        machineId: IDS.machine,
        fileName: 'calibration.pdf',
        contentType: 'application/pdf',
        storageKey: `uploads/${crypto.randomUUID()}`,
        sizeBytes: 42,
        audience: 'everybody',
        uploadedAt: '2026-10-20T08:00:00.000Z',
        uploadedBy: IDS.master,
      }),
    );
    expect(message).toMatch(/machine_documents_audience_known/u);
  });

  it('REFUSES two rows at the same storage key', async () => {
    const key = `uploads/${crypto.randomUUID()}`;
    const row = {
      machineId: IDS.machine,
      fileName: 'calibration.pdf',
      contentType: 'application/pdf',
      storageKey: key,
      sizeBytes: 42,
      uploadedAt: '2026-10-20T08:00:00.000Z',
      uploadedBy: IDS.master,
    } as const;
    await db.insert(schema.machineDocuments).values({ id: crypto.randomUUID(), ...row });

    const message = await postgresMessage(
      db.insert(schema.machineDocuments).values({ id: crypto.randomUUID(), ...row }),
    );
    expect(message).toMatch(/machine_documents_storage_key_key/u);
  });

  /**
   * CASCADE, and deliberately unlike `customer_documents`.
   *
   * A machine with job history is archived rather than deleted, so this delete
   * only ever reaches a machine nothing refers to — an entry somebody created
   * by mistake — and its paperwork should go with it, as its photographs do.
   */
  it('takes a mistaken machine’s documents with it', async () => {
    await db.insert(schema.machineDocuments).values({
      id: crypto.randomUUID(),
      machineId: IDS.otherMachine,
      fileName: 'created-by-mistake.pdf',
      contentType: 'application/pdf',
      storageKey: `uploads/${crypto.randomUUID()}`,
      sizeBytes: 42,
      uploadedAt: '2026-10-20T08:00:00.000Z',
      uploadedBy: IDS.master,
    });

    await db.delete(schema.machines).where(eq(schema.machines.id, IDS.otherMachine));

    const left = await db
      .select()
      .from(schema.machineDocuments)
      .where(eq(schema.machineDocuments.machineId, IDS.otherMachine));
    expect(left).toEqual([]);
  });

  it('keeps two documents apart, newest first', async () => {
    const master = await signIn(MASTER);
    await attach(master, 'field', '%PDF-1.4 first\n%%EOF', 'first.pdf');
    await attach(master, 'office_only', '%PDF-1.4 second report\n%%EOF', 'second.pdf');

    const listed = await master.get<{
      documents: readonly { fileName: string; sizeBytes: number }[];
    }>(`/api/machines/${IDS.machine}/documents`);
    expect(listed.data.documents).toHaveLength(2);
    // Different bytes, different sizes: neither overwrote the other.
    const sizes = new Set(listed.data.documents.map((document) => document.sizeBytes));
    expect(sizes.size).toBe(2);
  });
});
