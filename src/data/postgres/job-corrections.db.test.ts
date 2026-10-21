import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as schema from '@/db/schema';
import { IDS, seedBaseline } from './test-fixtures';
import { openTestDatabase, testDatabaseUrl, truncateAll } from './test-database';

/**
 * WHAT THE DATABASE ITSELF REFUSES ABOUT A CORRECTION. BD-02, IMMUT-9, AUD-3.
 *
 * The application's rules are tested against the demonstration backend, where
 * nothing enforces append-only. These are the guarantees a correction rests
 * on, and they only exist on PostgreSQL:
 *
 *   - what a correction SAYS cannot be rewritten (`job_corrections_guard`);
 *   - the acknowledgement may be filled in exactly once;
 *   - a correction cannot be deleted;
 *   - the document it corrects cannot be removed from under it;
 *   - and — the point of the whole feature — raising one does not touch the
 *     original job card, which the database still refuses to let anybody edit.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

const JOB = '00000000-0000-4000-8000-0000000000c1';
const DOCUMENT_KEY = 'jobcards/final/EJE-9001.pdf';

const messageOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error) return cause.message;
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('the statement was expected to be refused, and was not');
};

describeDb('a correction to an issued job card, on PostgreSQL', () => {
  let db: Database;

  beforeAll(async () => {
    db = await openTestDatabase(url ?? '');
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });

  /** A closed job with an issued, immutable document on it. */
  const seedIssuedJob = async (): Promise<void> => {
    await db.insert(schema.jobs).values({
      id: JOB,
      jobNumber: 'EJE-9001',
      jobNumberSeq: 9001,
      customerId: IDS.customer,
      siteId: IDS.site,
      contactId: IDS.contact,
      machineId: IDS.machine,
      jobTypeCode: 'service',
      priority: 'normal',
      status: 'closed',
    });
    await db.insert(schema.finalDocuments).values({
      id: '00000000-0000-4000-8000-0000000000d1',
      jobId: JOB,
      fileName: 'EJE-9001.pdf',
      storageKey: DOCUMENT_KEY,
      pageCount: 4,
      rendererVersion: 3,
      generatedAt: '2026-10-01T09:00:00.000Z',
      issuedTo: 'customer@example-test.co.za',
      provenance: 'genuine',
    });
  };

  const correction = (overrides: Record<string, unknown> = {}) => ({
    id: crypto.randomUUID(),
    jobId: JOB,
    sequence: 1,
    correctsDocumentKey: DOCUMENT_KEY,
    reason: 'The labour was charged at the wrong rate.',
    narrative: 'Three hours were charged after hours and should have been normal time.',
    areas: ['labour', 'charges'],
    raisedBy: IDS.master,
    raisedAt: '2026-10-21T08:00:00.000Z',
    documentFileName: 'EJE-9001-correction-1.pdf',
    documentStorageKey: `jobcards/corrections/${crypto.randomUUID()}.pdf`,
    documentSizeBytes: 2048,
    documentChecksumSha256: 'a'.repeat(64),
    ...overrides,
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seedBaseline(db);
    await seedIssuedJob();
  });

  it('accepts a correction, and leaves the original document untouched', async () => {
    await db.insert(schema.jobCorrections).values(correction());

    const documents = await db
      .select()
      .from(schema.finalDocuments)
      .where(eq(schema.finalDocuments.jobId, JOB));
    // The whole point: the bytes the customer holds are exactly as they were.
    expect(documents[0]?.storageKey).toBe(DOCUMENT_KEY);
    expect(documents[0]?.generatedAt).toBe('2026-10-01T09:00:00.000Z');

    // And the database still refuses to let anybody edit it.
    const refused = await messageOf(
      db
        .update(schema.finalDocuments)
        .set({ fileName: 'rewritten.pdf' })
        .where(eq(schema.finalDocuments.jobId, JOB)),
    );
    expect(refused).toMatch(/immutable historical record/u);
  });

  it('REFUSES rewriting what a correction says', async () => {
    const row = correction();
    await db.insert(schema.jobCorrections).values(row);

    const refused = await messageOf(
      db
        .update(schema.jobCorrections)
        .set({ reason: 'Something else entirely.' })
        .where(eq(schema.jobCorrections.id, row.id)),
    );
    expect(refused).toMatch(/cannot be rewritten/u);
    expect(refused).toMatch(/Raise another correction/u);
  });

  it('REFUSES deleting a correction', async () => {
    const row = correction();
    await db.insert(schema.jobCorrections).values(row);

    const refused = await messageOf(
      db.delete(schema.jobCorrections).where(eq(schema.jobCorrections.id, row.id)),
    );
    expect(refused).toMatch(/historical record and cannot be deleted/u);
  });

  /* -- the acknowledgement: once, and only forward --------------------------- */

  it('lets the acknowledgement be filled in once', async () => {
    const row = correction({ acknowledgement: 'required' });
    await db.insert(schema.jobCorrections).values(row);

    await db
      .update(schema.jobCorrections)
      .set({
        acknowledgement: 'recorded',
        acknowledgedBy: 'Pieter Nel',
        acknowledgementMethod: 'By telephone',
        acknowledgementRecordedBy: IDS.coordinator,
        acknowledgementRecordedAt: '2026-10-21T09:00:00.000Z',
      })
      .where(eq(schema.jobCorrections.id, row.id));

    const after = await db
      .select()
      .from(schema.jobCorrections)
      .where(eq(schema.jobCorrections.id, row.id));
    expect(after[0]?.acknowledgement).toBe('recorded');
  });

  it('REFUSES rewriting an acknowledgement that was already recorded', async () => {
    const row = correction({
      acknowledgement: 'recorded',
      acknowledgedBy: 'Pieter Nel',
      acknowledgementMethod: 'By telephone',
      acknowledgementRecordedAt: '2026-10-21T09:00:00.000Z',
    });
    await db.insert(schema.jobCorrections).values(row);

    const refused = await messageOf(
      db
        .update(schema.jobCorrections)
        .set({ acknowledgedBy: 'Somebody else' })
        .where(eq(schema.jobCorrections.id, row.id)),
    );
    expect(refused).toMatch(/already been acknowledged/u);
  });

  it('REFUSES a correction un-requiring an acknowledgement it asked for', async () => {
    const row = correction({ acknowledgement: 'required' });
    await db.insert(schema.jobCorrections).values(row);

    const refused = await messageOf(
      db
        .update(schema.jobCorrections)
        .set({ acknowledgement: 'not_required' })
        .where(eq(schema.jobCorrections.id, row.id)),
    );
    expect(refused).toMatch(/cannot stop requiring it/u);
  });

  /**
   * THE STATE AND THE DETAIL CANNOT DISAGREE. A row saying the customer
   * acknowledged it must say who and when — otherwise an audit reads
   * "acknowledged" with nothing behind it.
   */
  it('REFUSES a row claiming an acknowledgement with nobody behind it', async () => {
    const refused = await messageOf(
      db.insert(schema.jobCorrections).values(correction({ acknowledgement: 'recorded' })),
    );
    expect(refused).toMatch(/job_corrections_acknowledgement_consistent/u);
  });

  /* -- what a correction must say ------------------------------------------- */

  it('REFUSES a correction with a blank reason', async () => {
    const refused = await messageOf(
      db.insert(schema.jobCorrections).values(correction({ reason: '   ' })),
    );
    expect(refused).toMatch(/job_corrections_reason_present/u);
  });

  it('REFUSES a correction that names no part of the job card', async () => {
    const refused = await messageOf(
      db.insert(schema.jobCorrections).values(correction({ areas: [] })),
    );
    expect(refused).toMatch(/job_corrections_areas_present/u);
  });

  it('REFUSES two corrections at the same sequence on one job', async () => {
    await db.insert(schema.jobCorrections).values(correction());
    const refused = await messageOf(
      db.insert(schema.jobCorrections).values(correction()),
    );
    expect(refused).toMatch(/job_corrections_job_sequence_key/u);
  });

  /**
   * THE DOCUMENT IT CORRECTS CANNOT BE REMOVED FROM UNDER IT. RESTRICT, so a
   * correction always resolves to the exact bytes it refers to.
   */
  it('REFUSES removing the document a correction refers to', async () => {
    await db.insert(schema.jobCorrections).values(correction());

    const refused = await messageOf(
      db.delete(schema.finalDocuments).where(eq(schema.finalDocuments.jobId, JOB)),
    );
    // Either the document's own immutability or the correction's key: both are
    // correct answers and both mean the reference holds.
    expect(refused).toMatch(/immutable historical record|job_corrections/u);
  });

  it('REFUSES a correction pointing at a document that does not exist', async () => {
    const refused = await messageOf(
      db
        .insert(schema.jobCorrections)
        .values(correction({ correctsDocumentKey: 'jobcards/final/never-issued.pdf' })),
    );
    expect(refused).toMatch(/corrects_document_key/u);
  });
});

/**
 * THE MASTER'S AUTHORISATION TO SEND AN UNSIGNED JOB CARD. BD-06, AUD-4.
 *
 * Append-only, one per job, and it names the exact bytes it covers.
 */
describeDb('authorising an unsigned job card, on PostgreSQL', () => {
  let db: Database;

  beforeAll(async () => {
    db = await openTestDatabase(url ?? '');
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seedBaseline(db);
    await db.insert(schema.jobs).values({
      id: JOB,
      jobNumber: 'EJE-9001',
      jobNumberSeq: 9001,
      customerId: IDS.customer,
      siteId: IDS.site,
      contactId: IDS.contact,
      machineId: IDS.machine,
      jobTypeCode: 'service',
      priority: 'normal',
      status: 'closed',
    });
    await db.insert(schema.finalDocuments).values({
      id: '00000000-0000-4000-8000-0000000000d1',
      jobId: JOB,
      fileName: 'EJE-9001.pdf',
      storageKey: DOCUMENT_KEY,
      pageCount: 4,
      rendererVersion: 3,
      generatedAt: '2026-10-01T09:00:00.000Z',
      // Empty, because nothing was e-mailed when an unsigned card was issued.
      issuedTo: '',
      provenance: 'genuine',
    });
  });

  const authorisation = (overrides: Record<string, unknown> = {}) => ({
    id: crypto.randomUUID(),
    jobId: JOB,
    documentKey: DOCUMENT_KEY,
    recipient: 'customer@example-test.co.za',
    reason: 'The customer asked for a copy for their insurer.',
    authorisedBy: IDS.master,
    authorisedAt: '2026-10-21T08:00:00.000Z',
    ...overrides,
  });

  it('records one, and REFUSES a second for the same job', async () => {
    await db.insert(schema.unsignedDeliveryAuthorisations).values(authorisation());

    const refused = await messageOf(
      db.insert(schema.unsignedDeliveryAuthorisations).values(authorisation()),
    );
    expect(refused).toMatch(/unsigned_delivery_authorisations_job_key/u);
  });

  it('REFUSES rewriting or deleting a decision somebody took', async () => {
    const row = authorisation();
    await db.insert(schema.unsignedDeliveryAuthorisations).values(row);

    const updated = await messageOf(
      db
        .update(schema.unsignedDeliveryAuthorisations)
        .set({ reason: 'A different reason.' })
        .where(eq(schema.unsignedDeliveryAuthorisations.id, row.id)),
    );
    expect(updated).toMatch(/immutable historical record/u);

    const deleted = await messageOf(
      db
        .delete(schema.unsignedDeliveryAuthorisations)
        .where(eq(schema.unsignedDeliveryAuthorisations.id, row.id)),
    );
    expect(deleted).toMatch(/immutable historical record/u);
  });

  it('REFUSES an authorisation with no reason or no recipient', async () => {
    expect(
      await messageOf(
        db.insert(schema.unsignedDeliveryAuthorisations).values(authorisation({ reason: '  ' })),
      ),
    ).toMatch(/reason_present/u);

    expect(
      await messageOf(
        db.insert(schema.unsignedDeliveryAuthorisations).values(authorisation({ recipient: '' })),
      ),
    ).toMatch(/recipient_present/u);
  });

  it('REFUSES one naming a document that does not exist', async () => {
    const refused = await messageOf(
      db
        .insert(schema.unsignedDeliveryAuthorisations)
        .values(authorisation({ documentKey: 'jobcards/final/never-issued.pdf' })),
    );
    expect(refused).toMatch(/document_key/u);
  });
});
