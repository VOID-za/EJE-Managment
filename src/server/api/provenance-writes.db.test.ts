import { mkdtemp, rm } from 'node:fs/promises';
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
 * EVERY WRITE PATH STATES WHERE THE RECORD CAME FROM. October mandate §1.3.
 *
 * WHY THIS FILE EXISTS, and it is the most expensive lesson this column has
 * taught. `provenance` used to default to `genuine`. Two inserts —
 * `JobRepository.save` and the machine-photograph insert — omitted the field,
 * the default filled it in, and `documents:reconcile` reported six
 * demonstration job cards as LOST CUSTOMER DOCUMENTS. The API said the right
 * thing throughout; only counting rows in the database found it.
 *
 * The default is now `unknown`, which turns that class of omission from a
 * false claim into a visible gap — and makes THIS test the thing that has to
 * hold: every path a real file travels must put `genuine` in the column
 * ITSELF, not in the response.
 *
 * So each case reads the column after an upload through the real route. A
 * response is not evidence here; a row is.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

const PASSWORD = 'a-real-test-password';
const MASTER = 'elmarie@example-test.co.za';
const PDF = '%PDF-1.4\nreal paperwork\n%%EOF';
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

describeDb('provenance reaches the column on every write path', () => {
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
    storageRoot = await mkdtemp(join(tmpdir(), 'eje-provenance-'));
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

  it('records a CUSTOMER document as genuine', async () => {
    const master = await signIn(MASTER);
    const attached = await master.upload<{ document: { id: string } }>(
      `/api/customers/${IDS.customer}/documents`,
      {
        name: 'agreement.pdf',
        type: 'application/pdf',
        bytes: new TextEncoder().encode(PDF),
        fields: { caption: 'Signed agreement' },
      },
    );
    expect(attached.status, JSON.stringify(attached.error)).toBe(200);

    const rows = await db
      .select({ provenance: schema.customerDocuments.provenance })
      .from(schema.customerDocuments)
      .where(eq(schema.customerDocuments.id, attached.data.document.id));
    expect(rows[0]?.provenance).toBe('genuine');
  });

  it('records a MACHINE document as genuine', async () => {
    const master = await signIn(MASTER);
    const attached = await master.upload<{ document: { id: string } }>(
      `/api/machines/${IDS.machine}/documents`,
      {
        name: 'calibration.pdf',
        type: 'application/pdf',
        bytes: new TextEncoder().encode(PDF),
        fields: { caption: 'Calibration', audience: 'field' },
      },
    );
    expect(attached.status, JSON.stringify(attached.error)).toBe(200);

    const rows = await db
      .select({ provenance: schema.machineDocuments.provenance })
      .from(schema.machineDocuments)
      .where(eq(schema.machineDocuments.id, attached.data.document.id));
    expect(rows[0]?.provenance).toBe('genuine');
  });

  /**
   * THE PATH THAT ACTUALLY BROKE. A machine photograph's provenance was
   * dropped by the repository insert, not by the operation.
   */
  it('records a MACHINE PHOTOGRAPH as genuine', async () => {
    const master = await signIn(MASTER);
    const uploaded = await master.upload(`/api/machines/${IDS.machine}/photos`, {
      name: 'plate.png',
      type: 'image/png',
      bytes: PNG,
      fields: { caption: 'Rating plate' },
    });
    expect(uploaded.status, JSON.stringify(uploaded.error)).toBe(200);

    const rows = await db
      .select({ provenance: schema.machinePhotos.provenance })
      .from(schema.machinePhotos)
      .where(eq(schema.machinePhotos.machineId, IDS.machine));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.provenance).toBe('genuine');
  });

  /**
   * AND THE COLUMN'S DEFAULT IS NOW THE SAFE ONE. An insert that forgets the
   * field lands on "nobody recorded this" rather than on a claim — which is
   * the whole reason the default changed, so it is asserted rather than
   * assumed.
   */
  it('defaults to unknown when an insert says nothing', async () => {
    await db.insert(schema.machineDocuments).values({
      id: crypto.randomUUID(),
      machineId: IDS.machine,
      fileName: 'forgotten.pdf',
      contentType: 'application/pdf',
      storageKey: `uploads/${crypto.randomUUID()}`,
      sizeBytes: 11,
      uploadedAt: '2026-10-21T08:00:00.000Z',
      uploadedBy: IDS.master,
    });

    const rows = await db
      .select({ provenance: schema.machineDocuments.provenance })
      .from(schema.machineDocuments)
      .where(eq(schema.machineDocuments.fileName, 'forgotten.pdf'));
    expect(rows[0]?.provenance).toBe('unknown');
  });

  it('REFUSES a provenance nobody defined', async () => {
    let message = '';
    try {
      await db.insert(schema.machineDocuments).values({
        id: crypto.randomUUID(),
        machineId: IDS.machine,
        fileName: 'invented.pdf',
        contentType: 'application/pdf',
        storageKey: `uploads/${crypto.randomUUID()}`,
        sizeBytes: 11,
        provenance: 'probably-fine',
        uploadedAt: '2026-10-21T08:00:00.000Z',
        uploadedBy: IDS.master,
      });
    } catch (error) {
      const cause = (error as { cause?: unknown }).cause;
      message = cause instanceof Error ? cause.message : String(error);
    }
    expect(message).toMatch(/machine_documents_provenance_known/u);
  });

  /**
   * WHEN THIS DATABASE BEGAN RECORDING. Migration 0018 writes one row, and
   * `documents:reconcile` spends it on the one table it could not relabel.
   */
  it('records when provenance recording began, exactly once', async () => {
    const rows = await db.select().from(schema.provenanceRecording);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('cutoff');
    expect(Number.isNaN(Date.parse(rows[0]?.recordedFrom ?? ''))).toBe(false);
    expect(rows[0]?.note).toMatch(/never recorded/u);
  });
});
