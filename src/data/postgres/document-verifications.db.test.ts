import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as schema from '@/db/schema';
import { asUserId } from '@/domain';
import { PostgresJobRepository } from './job-repository';
import { openTestDatabase, testDatabaseUrl, truncateAll } from './test-database';
import { IDS, jobFixture, seedBaseline } from './test-fixtures';

/**
 * WHAT AN ISSUED DOCUMENT'S ROW SAYS, AND WHAT MAY BE SAID BESIDE IT.
 * BACKUP-1.
 *
 * Two halves of the same defect, both on real PostgreSQL because both are
 * about what the DATABASE does:
 *
 *   - `final_documents.size_bytes` and `.checksum_sha256` were columns nothing
 *     wrote, so every row on the live server read `size_bytes = 0` with no
 *     checksum while the schema claimed the checksum was verified on every
 *     read. The repository writes both now, from what the store measured.
 *
 *   - they CANNOT be back-filled on the rows that predate that, because
 *     `final_documents` is write-once and `0002_immutability.sql` refuses
 *     UPDATE on it. That refusal was left alone — it is one of the things CR-01
 *     rests on — and the measurement goes into an append-only record beside the
 *     document instead, which is what the trigger's own message tells you to
 *     do.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

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

describeDb('an issued document on PostgreSQL', () => {
  let db: Database;
  let jobs: PostgresJobRepository;

  beforeAll(async () => {
    db = await openTestDatabase(url ?? '');
  });

  afterAll(async () => {
    await db.execute(sql`select 1`);
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seedBaseline(db);
    jobs = new PostgresJobRepository(db);
  });

  const BYTES = 10_422;
  const HASH = '7556fb0c8323d39f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071';

  const withDocument = async (over: Record<string, unknown> = {}) => {
    const job = jobFixture('EJE-9001', {
      status: 'awaiting_delivery',
      finalDocument: {
        fileName: 'EJE-9001-Final-Job-Card.pdf',
        storageKey: 'jobcards/final/EJE-9001.pdf',
        pageCount: 2,
        generatedAt: '2026-10-20T09:00:00.000Z',
        generatedBy: asUserId(IDS.master),
        renderedLocally: false,
        issuedTo: 'accounts@example-test.co.za',
        sizeBytes: BYTES,
        checksumSha256: HASH,
        renderer: 3,
        ...over,
      },
    });
    await jobs.save(job);
    const rows = await db
      .select()
      .from(schema.finalDocuments)
      .where(eq(schema.finalDocuments.jobId, job.id));
    return { job, row: rows[0] };
  };

  it('records the LENGTH and CHECKSUM the store measured', async () => {
    const { row } = await withDocument();

    // Before the fix both of these were the column defaults — 0 and null — on
    // every row the application had ever written.
    expect(row?.sizeBytes).toBe(BYTES);
    expect(row?.checksumSha256).toBe(HASH);
    expect(row?.rendererVersion).toBe(3);
  });

  it('reads an unmeasured document back as UNKNOWN rather than as an empty file', async () => {
    const { job } = await withDocument({ sizeBytes: null, checksumSha256: null, renderer: null });

    // The column cannot hold "unknown", so 0 is what is stored — and the
    // mapper has to read it back as null, because a job card is never
    // genuinely 0 bytes and "an empty document" is a different claim.
    const read = await jobs.findById(job.id);
    expect(read?.finalDocument?.sizeBytes).toBeNull();
    expect(read?.finalDocument?.checksumSha256).toBeNull();
    expect(read?.finalDocument?.renderer).toBeNull();
  });

  it('round trips what it recorded', async () => {
    const { job } = await withDocument();
    const read = await jobs.findById(job.id);

    expect(read?.finalDocument?.sizeBytes).toBe(BYTES);
    expect(read?.finalDocument?.checksumSha256).toBe(HASH);
  });

  /* -- the row itself stays untouchable, and that is deliberate ------------- */

  it('REFUSES to have its size filled in afterwards, as the first reconcile tried to', async () => {
    const { row } = await withDocument({ sizeBytes: null, checksumSha256: null, renderer: null });

    const message = await postgresMessage(
      db
        .update(schema.finalDocuments)
        .set({ sizeBytes: BYTES, checksumSha256: HASH })
        .where(eq(schema.finalDocuments.id, row?.id ?? '')),
    );
    expect(message).toMatch(/immutable historical record/u);
  });

  it('takes an OBSERVATION beside it instead, which is what the refusal says to do', async () => {
    const { row } = await withDocument({ sizeBytes: null, checksumSha256: null, renderer: null });

    await db.insert(schema.finalDocumentVerifications).values({
      id: crypto.randomUUID(),
      finalDocumentId: row?.id ?? '',
      storageKey: row?.storageKey ?? '',
      verdict: 'unrecorded',
      sizeBytes: BYTES,
      checksumSha256: HASH,
      rendererVersion: 3,
      detail: 'The file is there and the row records neither its length nor its checksum.',
      verifiedAt: '2026-10-20T18:45:00.000Z',
    });

    const observations = await db.select().from(schema.finalDocumentVerifications);
    expect(observations).toHaveLength(1);
    expect(observations[0]?.sizeBytes).toBe(BYTES);
  });

  it('REFUSES to have an observation rewritten or removed', async () => {
    const { row } = await withDocument();
    const id = crypto.randomUUID();
    await db.insert(schema.finalDocumentVerifications).values({
      id,
      finalDocumentId: row?.id ?? '',
      storageKey: row?.storageKey ?? '',
      verdict: 'intact',
      sizeBytes: BYTES,
      checksumSha256: HASH,
      rendererVersion: 3,
      detail: '10422 bytes, checksum recorded and matching.',
      verifiedAt: '2026-10-20T18:45:00.000Z',
    });

    // Evidence that can be edited after the fact is not evidence.
    expect(
      await postgresMessage(
        db
          .update(schema.finalDocumentVerifications)
          .set({ verdict: 'intact', sizeBytes: 1 })
          .where(eq(schema.finalDocumentVerifications.id, id)),
      ),
    ).toMatch(/immutable historical record/u);

    expect(
      await postgresMessage(
        db
          .delete(schema.finalDocumentVerifications)
          .where(eq(schema.finalDocumentVerifications.id, id)),
      ),
    ).toMatch(/immutable historical record/u);
  });

  it('REFUSES to lose an observation by deleting the document it is about', async () => {
    const { row } = await withDocument();
    await db.insert(schema.finalDocumentVerifications).values({
      id: crypto.randomUUID(),
      finalDocumentId: row?.id ?? '',
      storageKey: row?.storageKey ?? '',
      verdict: 'intact',
      sizeBytes: BYTES,
      checksumSha256: HASH,
      rendererVersion: 3,
      detail: 'matching',
      verifiedAt: '2026-10-20T18:45:00.000Z',
    });

    const message = await postgresMessage(
      db.delete(schema.finalDocuments).where(eq(schema.finalDocuments.id, row?.id ?? '')),
    );
    // Either guard answering is correct — the document is immutable AND the
    // observation references it. What must not happen is a silent removal.
    expect(message).toMatch(/immutable historical record|final_document_verifications/u);
  });
});
