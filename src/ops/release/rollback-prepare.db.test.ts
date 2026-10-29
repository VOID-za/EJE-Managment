import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDatabase, type Database } from '@/db/client';
import { testDatabaseUrl } from '@/data/postgres/test-database';
import { IDS, jobFixture, seedBaseline } from '@/data/postgres/test-fixtures';
import { PostgresDocumentRepository } from '@/data/postgres/document-repository';
import { PostgresJobRepository } from '@/data/postgres/job-repository';
import { asDocumentId, asUserId, type DocumentTextIndex, type TechnicalDocument } from '@/domain';
import { ROLLBACK_DOCUMENTS, ROLLBACK_TIMESHEET } from './rollback-fixture';
import { PostgresAttendanceRepository } from '@/data/postgres/attendance-repository';
import { PostgresDeliveryNoteRepository } from '@/data/postgres/delivery-note-repository';
import { asCustomerId, asJobId, type TimesheetEntry } from '@/domain';

/**
 * ROLLBACK COMPATIBILITY, PHASE 1 OF 2: THIS RELEASE PREPARES THE DATABASE.
 *
 * Run only by `scripts/release/rollback-compat.sh` (RELEASE_ROLLBACK_PHASE=
 * prepare), never by `npm run db:test` — it leaves the database in place for
 * phase 2, which is the LIVE release's own code reading and writing it.
 *
 * It migrates a disposable test database to `0030` through the real migrator,
 * exactly as the release will, and writes a library document in every indexing
 * state this release can produce — including the one only it can produce:
 * `partially_indexed` with the page coverage UNKNOWN (0 of M). That row is the
 * whole question: if the release is rolled back after `0030` has run, the old
 * code meets it.
 */
const url = testDatabaseUrl();
const requested = process.env.RELEASE_ROLLBACK_PHASE === 'prepare';
/*
 * ASKED FOR AND UNABLE TO RUN IS A FAILURE, NOT A SKIP. A skipped test exits 0,
 * so a CI step that ran nothing would look exactly like one that proved
 * rollback compatibility. rollback-compat.sh also refuses any run that reports
 * a skipped or zero passed test.
 */
if (requested && url === null) {
  throw new Error('RELEASE_ROLLBACK_PHASE=prepare needs TEST_DATABASE_URL naming a disposable test database.');
}
const enabled = requested;
const describePhase = enabled ? describe : describe.skip;

const technicalDocument = (id: string, name: string): TechnicalDocument => ({
  id: asDocumentId(id),
  name,
  description: 'Written by the rollback-compatibility preparation.',
  documentType: 'service_manual',
  manufacturer: 'Leadwell',
  machineModel: 'V40',
  version: '1.0',
  status: 'current',
  fileName: `${id}.pdf`,
  fileSizeBytes: 1024,
  checksumSha256: null,
  pageCount: 10,
  storageKey: `uploads/${id}`,
  provenance: 'genuine',
  uploadedAt: '2026-10-01T08:00:00.000Z',
  uploadedBy: asUserId(IDS.master),
  tags: [],
});

const index = (documentId: string, over: Partial<DocumentTextIndex>): DocumentTextIndex => ({
  documentId: asDocumentId(documentId),
  state: 'indexed',
  source: 'text_layer',
  extractedAt: '2026-10-25T08:00:00.000Z',
  characters: 0,
  pages: 10,
  pagesIndexed: 10,
  truncated: false,
  unreadableStreams: 0,
  failureReason: '',
  ...over,
});

const pageRows = (documentId: string, numbers: readonly number[]) =>
  numbers.map((pageNumber) => {
    const content = `Page ${pageNumber}: check the spindle drive parameter before restart.`;
    return {
      documentId: asDocumentId(documentId),
      pageNumber,
      source: 'text_layer' as const,
      characters: content.length,
      content,
    };
  });

describePhase('rollback compatibility — phase 1: this release migrates to 0030 and writes every state', () => {
  let db: Database;

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
  });

  it('migrates a disposable database to 0030 through the real migrator', async () => {
    db = createDatabase({ connectionString: url ?? '', maxConnections: 2 });
    await db.execute(sql`drop schema if exists public cascade`);
    await db.execute(sql`drop schema if exists drizzle cascade`);
    await db.execute(sql`create schema public`);
    await migrate(db, { migrationsFolder: join(process.cwd(), 'src/db/migrations') });
    const rows = await db.execute<{ n: string }>(sql`select count(*)::text as n from drizzle.__drizzle_migrations`);
    // Every migration this checkout ships — 0030, and 0031 onwards when present.
    const shipped = (
      JSON.parse(readFileSync(join(process.cwd(), 'src/db/migrations/meta/_journal.json'), 'utf8')) as {
        entries: readonly unknown[];
      }
    ).entries.length;
    expect(Number(rows[0]?.n)).toBe(shipped);
  }, 120_000);

  it('writes a library document in every indexing state, "coverage unknown" included', async () => {
    await seedBaseline(db);
    const repository = new PostgresDocumentRepository(db);
    const { indexed, partial, needsOcr, failed, coverageUnknown } = ROLLBACK_DOCUMENTS;
    for (const [name, id] of Object.entries(ROLLBACK_DOCUMENTS)) {
      await repository.save(technicalDocument(id, `Rollback ${name}`));
    }

    const full = pageRows(indexed, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    await repository.saveTextIndex(
      index(indexed, { characters: full.reduce((sum, page) => sum + page.characters, 0) }),
      full.map((page) => page.content).join('\n\n'),
      full,
    );
    const seven = pageRows(partial, [1, 2, 3, 5, 6, 8, 9]);
    await repository.saveTextIndex(
      index(partial, {
        state: 'partially_indexed',
        pagesIndexed: 7,
        characters: seven.reduce((sum, page) => sum + page.characters, 0),
        failureReason: 'No text could be read from pages 4, 7, 10.',
      }),
      seven.map((page) => page.content).join('\n\n'),
      seven,
    );
    await repository.saveTextIndex(
      index(needsOcr, { state: 'needs_ocr', source: null, pagesIndexed: 0, failureReason: 'A scan.' }),
      '',
    );
    await repository.saveTextIndex(
      index(failed, { state: 'failed', source: null, pagesIndexed: 0, failureReason: 'Damaged.' }),
      '',
    );
    // ONLY THIS RELEASE CAN WRITE THIS ROW (migration 0030): the built-in reader,
    // cut at its summary budget, with no page rows and coverage unknown.
    const summary = 'Coolant pressure alarm 2071 means the filter is blocked. The rest was cut.';
    const saved = await repository.saveTextIndex(
      index(coverageUnknown, {
        state: 'partially_indexed',
        pages: 214,
        pagesIndexed: 0,
        characters: summary.length,
        truncated: true,
        failureReason: 'This server has no pdftotext; the rest is not searchable.',
      }),
      summary,
    );
    expect(saved.pagesIndexed).toBe(0);
    expect(saved.state).toBe('partially_indexed');
  });

  /*
   * 0031: `jobs.date_received`. A Test & Repair job carrying a date received
   * is the one job shape only this release writes; phase 2 has the live code
   * read it and write a job of its own beside it.
   */
  it('writes a Test & Repair job carrying a date received (0031)', async () => {
    const jobs = new PostgresJobRepository(db);
    // A number from the sequence, as every saved job has: the repository keeps
    // the sequence value beside it, so an invented number cannot be stored.
    // Phase 2 finds this job as the only Test & Repair on the database.
    const allocated = await jobs.allocateJobNumber();
    const saved = await jobs.save(
      jobFixture(allocated.jobNumber, { jobType: 'test_and_repair', dateReceived: '2026-10-20' }),
    );
    expect(saved.dateReceived).toBe('2026-10-20');
    expect((await jobs.list()).filter((job) => job.jobType === 'test_and_repair')).toHaveLength(1);
  });

  /*
   * 0037–0039: an absence reason, a Workshop line with a call-out amount and
   * kilometres, a period SENT to the office, an ACCEPTED correction of it, and
   * an issued Delivery Note. Phase 2 has the live code (ef0f695) meet them.
   */
  it('writes the timesheet, attendance and delivery-note rows only this release can (0037–0039)', async () => {
    const attendance = new PostgresAttendanceRepository(db);
    const T = ROLLBACK_TIMESHEET;
    const tech = asUserId(IDS.technician);
    await attendance.saveRecord({
      id: crypto.randomUUID(), userId: tech, date: T.absentDay, status: 'absent', absenceReason: 'sick_leave',
      note: '', recordedBy: asUserId(IDS.master), recordedAt: '2026-10-20T08:00:00.000Z',
    });
    const entry = (id: string, over: Partial<TimesheetEntry>): TimesheetEntry => ({
      id, userId: tech, date: '2026-10-21', customerId: null, customerName: '', workshop: false,
      normalHours: 0, overtimeHours: 2, doubleHours: 0, callouts: 0, calloutAmount: 0, calloutShared: false,
      internalKm: 0, customerKm: 0, updatedBy: tech, updatedAt: '2026-10-21T17:00:00.000Z', ...over,
    });
    const workshop = await attendance.saveEntry(entry(T.workshopLine, { workshop: true, internalKm: 12.5 }));
    const customer = await attendance.saveEntry(entry(T.customerLine, {
      date: '2026-10-22', customerId: asCustomerId(IDS.customer), customerName: 'Test customer',
      calloutAmount: 50000, calloutShared: true, customerKm: 40,
    }));
    const snapshot = { technicianName: 'Sipho', from: '2026-10-19', to: '2026-10-25', comment: 'Sent.', entries: [workshop, customer] };
    const sent = await attendance.submitPeriod({
      id: T.period, userId: tech, from: '2026-10-19', to: '2026-10-25', comment: 'Sent.', updatedBy: tech,
      updatedAt: '2026-10-26T08:00:00.000Z', submittedAt: '2026-10-26T08:00:00.000Z', submittedBy: tech, snapshot,
    });
    expect(sent?.submittedAt).not.toBeNull();
    const asked = await attendance.createCorrection({
      id: T.correction, periodId: T.period, userId: tech, sequence: 1, reason: 'OT was 3',
      before: snapshot, after: { ...snapshot, entries: [{ ...workshop, overtimeHours: 3 }, customer] },
      requestedBy: tech, requestedAt: '2026-10-27T08:00:00.000Z', status: 'pending', decidedBy: null, decidedAt: null, decisionNote: '',
    });
    expect(asked?.status).toBe('pending');
    const accepted = await attendance.decideCorrection({
      id: T.correction, status: 'accepted', decidedBy: asUserId(IDS.master), decidedAt: '2026-10-27T09:00:00.000Z', decisionNote: '',
    });
    expect(accepted?.status).toBe('accepted');

    const job = (await new PostgresJobRepository(db).list()).find((candidate) => candidate.jobType === 'test_and_repair');
    const note = await new PostgresDeliveryNoteRepository(db).record({
      id: T.deliveryNote, jobId: asJobId(job!.id), fileName: 'delivery-note.pdf', storageKey: 'documents/rollback-delivery-note.pdf',
      pageCount: 1, sizeBytes: 100, checksumSha256: null, generatedAt: '2026-10-27T10:00:00.000Z', generatedBy: tech,
      jobCardDocumentKey: 'documents/rollback-job-card.pdf', signedByName: 'Johan Courier', signedAt: '2026-10-27T10:00:00.000Z',
      signatureSha256: 'a'.repeat(64),
    });
    expect(note.jobId).toBe(job!.id);
  });
});
