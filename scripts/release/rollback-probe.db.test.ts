import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { createDatabase, type Database } from '@/db/client';
import { testDatabaseUrl } from '@/data/postgres/test-database';
import { IDS, jobFixture } from '@/data/postgres/test-fixtures';
import { PostgresDocumentRepository } from '@/data/postgres/document-repository';
import { PostgresJobRepository } from '@/data/postgres/job-repository';
import { describeSearchability } from '@/application/library-ocr';
import { checkMigrations } from '@/ops/preflight-rules';
import { asDocumentId, asUserId, type DocumentId, type TechnicalDocument } from '@/domain';
import { PostgresAttendanceRepository } from '@/data/postgres/attendance-repository';

/**
 * ROLLBACK COMPATIBILITY, PHASE 2 OF 2: THE LIVE RELEASE'S OWN CODE.
 *
 * THIS FILE RUNS INSIDE A CHECKOUT OF THE LIVE RELEASE (ef0f695), copied there
 * by `scripts/release/rollback-compat.sh`, so every `@/…` import below is the
 * LIVE code — the repository, the searchability wording and the preflight rule
 * as they are on the server today. It must therefore import only what exists
 * in ef0f695, and it does: each of these was checked against that commit.
 *
 * The database was migrated to the newest migration THIS release ships (0039)
 * and populated by it (phase 1). The question is the one a rollback asks: after
 * the migrations have run, does the old code still read and write — the
 * library, jobs, and (0037–0039) attendance and timesheets, beside absence
 * reasons, Workshop lines, sent periods, corrections and Delivery Notes it has
 * never heard of?
 *
 * Skipped unless RELEASE_ROLLBACK_PHASE=probe, so it never runs by accident.
 */
const url = testDatabaseUrl();
const requested = process.env.RELEASE_ROLLBACK_PHASE === 'probe';
/*
 * ASKED FOR AND UNABLE TO RUN IS A FAILURE, NOT A SKIP. A skipped test exits 0,
 * so a CI step that ran nothing would look exactly like one that proved
 * rollback compatibility. rollback-compat.sh also refuses any run that reports
 * a skipped or zero passed test.
 */
if (requested && url === null) {
  throw new Error('RELEASE_ROLLBACK_PHASE=probe needs TEST_DATABASE_URL naming a disposable test database.');
}
const enabled = requested;
const describePhase = enabled ? describe : describe.skip;

// A copy of `src/ops/release/rollback-fixture.ts`, which the live release does
// not have; `rollback-fixture.test.ts` asserts the two are identical.
const DOCUMENTS = {
  indexed: '00000000-0000-4000-8000-0000000004a1',
  partial: '00000000-0000-4000-8000-0000000004a2',
  needsOcr: '00000000-0000-4000-8000-0000000004a3',
  failed: '00000000-0000-4000-8000-0000000004a4',
  coverageUnknown: '00000000-0000-4000-8000-0000000004a5',
} as const;
const WRITTEN_BY_OLD_CODE = '00000000-0000-4000-8000-0000000004b1';

// A copy of ROLLBACK_TIMESHEET in `src/ops/release/rollback-fixture.ts`.
const TIMESHEET = {
  absentDay: '2026-10-20',
  workshopLine: '00000000-0000-4000-8000-0000000005a1',
  customerLine: '00000000-0000-4000-8000-0000000005a2',
  period: '00000000-0000-4000-8000-0000000005b1',
  correction: '00000000-0000-4000-8000-0000000005c1',
  deliveryNote: '00000000-0000-4000-8000-0000000005d1',
} as const;

const id = (value: string): DocumentId => asDocumentId(value);

describePhase('rollback compatibility — phase 2: the live release (ef0f695) against a database at 0039', () => {
  let db: Database;
  let repository: PostgresDocumentRepository;

  beforeAll(() => {
    db = createDatabase({ connectionString: url ?? '', maxConnections: 2 });
    repository = new PostgresDocumentRepository(db);
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });

  it("the live release's preflight does not refuse a database migrations ahead of it", async () => {
    const journal = JSON.parse(
      readFileSync(join(process.cwd(), 'src/db/migrations/meta/_journal.json'), 'utf8'),
    ) as { entries: { tag: string }[] };
    const shipped = journal.entries.map((entry) => entry.tag);
    expect(shipped).toHaveLength(37);
    expect(shipped.at(-1)).toBe('0036_chat_deleted_for');
    expect(shipped).not.toContain('0037_reviewer_timesheets_attendance');

    const rows = await db.execute<{ n: string }>(sql`select count(*)::text as n from drizzle.__drizzle_migrations`);
    const applied = Number(rows[0]?.n);
    // 0037, 0038 and 0039 applied beyond what the live release ships.
    expect(applied).toBe(40);

    const checks = checkMigrations(shipped, { applied, schemaPresent: true });
    expect(checks.every((check) => check.verdict !== 'fail')).toBe(true);
  });

  it('reads every indexing state the new release wrote', async () => {
    const all = await repository.listTextIndexes(Object.values(DOCUMENTS).map(id));
    expect(all).toHaveLength(5);
    expect((await repository.findTextIndex(id(DOCUMENTS.indexed)))?.state).toBe('indexed');
    expect((await repository.findTextIndex(id(DOCUMENTS.partial)))?.pagesIndexed).toBe(7);
    expect((await repository.findTextIndex(id(DOCUMENTS.needsOcr)))?.state).toBe('needs_ocr');
    expect((await repository.findTextIndex(id(DOCUMENTS.failed)))?.state).toBe('failed');
  });

  it('reads the "coverage unknown" row without error, and still calls it searchable', async () => {
    const unknown = await repository.findTextIndex(id(DOCUMENTS.coverageUnknown));
    expect(unknown?.state).toBe('partially_indexed');
    expect(unknown?.pagesIndexed).toBe(0);
    /*
     * The live wording for 0 of M is "Searchable — 0 of 214 pages": a
     * cosmetic understatement for as long as a rolled-back release runs, and
     * recorded as such in docs/deploy-next-release.md. What matters is that it
     * does not throw and does not call the document unsearchable.
     */
    const said = describeSearchability(unknown, null);
    expect(said.searchable).toBe(true);
  });

  it('still SEARCHES the library, the "coverage unknown" document included', async () => {
    const candidates = Object.values(DOCUMENTS).map(id);
    expect(await repository.searchTextIds(['coolant', '2071'], candidates, 10)).toEqual([
      id(DOCUMENTS.coverageUnknown),
    ]);
    const spindle = await repository.searchTextIds(['spindle'], candidates, 10);
    expect([...spindle].sort()).toEqual([id(DOCUMENTS.indexed), id(DOCUMENTS.partial)].sort());
    const pages = await repository.findPageMatches(id(DOCUMENTS.partial), ['spindle'], 10);
    expect(pages.map((page) => page.pageNumber).sort((a, b) => a - b)).toEqual([1, 2, 3, 5, 6, 8, 9]);
  });

  it('still WRITES: a new document indexed by the live code is accepted under the 0030 rule', async () => {
    const document: TechnicalDocument = {
      id: id(WRITTEN_BY_OLD_CODE),
      name: 'Indexed by the live release after a rollback',
      description: '',
      documentType: 'service_manual',
      manufacturer: 'Leadwell',
      machineModel: 'V40',
      version: '1.0',
      status: 'current',
      fileName: 'rolled-back.pdf',
      fileSizeBytes: 1024,
      checksumSha256: null,
      pageCount: 4,
      storageKey: `uploads/${WRITTEN_BY_OLD_CODE}`,
      provenance: 'genuine',
      uploadedAt: '2026-10-25T09:00:00.000Z',
      uploadedBy: asUserId(IDS.master),
      tags: [],
    };
    await repository.save(document);
    const content = 'Three pages of text and one diagram.';
    const saved = await repository.saveTextIndex(
      {
        documentId: id(WRITTEN_BY_OLD_CODE),
        state: 'partially_indexed',
        source: 'text_layer',
        extractedAt: '2026-10-25T09:00:00.000Z',
        characters: content.length,
        pages: 4,
        pagesIndexed: 3,
        truncated: false,
        unreadableStreams: 0,
        failureReason: 'No text could be read from page 3.',
      },
      content,
      [1, 2, 4].map((pageNumber) => ({
        documentId: id(WRITTEN_BY_OLD_CODE),
        pageNumber,
        source: 'text_layer' as const,
        characters: content.length,
        content,
      })),
    );
    expect(saved.pagesIndexed).toBe(3);

    // And re-indexing the new release's "coverage unknown" row as the live code
    // would (a whole reading) is accepted too.
    const reindexed = await repository.saveTextIndex(
      {
        documentId: id(DOCUMENTS.coverageUnknown),
        state: 'indexed',
        source: 'text_layer',
        extractedAt: '2026-10-25T09:05:00.000Z',
        characters: content.length,
        pages: 214,
        pagesIndexed: 214,
        truncated: false,
        unreadableStreams: 0,
        failureReason: '',
      },
      content,
    );
    expect(reindexed.state).toBe('indexed');
  });

  /*
   * 0031 ADDED `jobs.date_received`. The live release knows nothing of the
   * column: it must still read a job this release wrote WITH one, and still
   * write a job of its own — leaving the column NULL, which is "not recorded".
   */
  it('still reads and writes JOBS on a database with 0031 applied', async () => {
    const jobs = new PostgresJobRepository(db);
    // Phase 1's job: the only Test & Repair, written WITH a date received.
    const written = (await jobs.list()).filter((job) => job.jobType === 'test_and_repair');
    expect(written).toHaveLength(1);
    expect((await jobs.findByJobNumber(written[0]!.jobNumber))?.jobType).toBe('test_and_repair');

    // And one of its own, numbered from the sequence as the live code numbers jobs.
    const allocated = await jobs.allocateJobNumber();
    await jobs.save(jobFixture(allocated.jobNumber));
    expect((await jobs.findByJobNumber(allocated.jobNumber))?.jobNumber).toBe(allocated.jobNumber);
    const [row] = await db.execute<{ date_received: string | null }>(
      sql`select date_received from jobs where job_number = ${allocated.jobNumber}`,
    );
    expect(row?.date_received ?? null).toBeNull();
  });

  /*
   * 0037–0039. The live release has never heard of absence reasons, Workshop,
   * call-out amounts, kilometres, sent periods, corrections or Delivery Notes.
   * After a rollback it must still read the register and the timesheet lines,
   * and still write its own — the new columns take their defaults, and the
   * new tables are left alone.
   */
  it('still reads and writes ATTENDANCE and TIMESHEET LINES on a database at 0039', async () => {
    const attendance = new PostgresAttendanceRepository(db);
    const tech = asUserId(IDS.technician);
    const records = await attendance.listRecords(TIMESHEET.absentDay, TIMESHEET.absentDay, tech);
    expect(records.map((record) => record.status)).toEqual(['absent']);
    // An absent day of its own, with no reason (the old screen asks for none): accepted.
    // The OLD shapes, exactly as ef0f695 types them; cast only so this checkout's
    // newer types accept the file (it runs against ef0f695's own).
    const own = await attendance.saveRecord({
      id: crypto.randomUUID(), userId: tech, date: '2026-10-23', status: 'absent', note: 'rolled back',
      recordedBy: asUserId(IDS.master), recordedAt: '2026-10-23T08:00:00.000Z',
    } as Parameters<typeof attendance.saveRecord>[0]);
    expect(own.status).toBe('absent');

    const lines = await attendance.listEntries(tech, '2026-10-19', '2026-10-25');
    expect(lines.map((line) => line.id).sort()).toEqual([TIMESHEET.workshopLine, TIMESHEET.customerLine].sort());
    // A line in the old shape — NT and a call-out count — is still written.
    const written = await attendance.saveEntry({
      id: crypto.randomUUID(), userId: tech, date: '2026-10-28', customerId: null, customerName: 'Old-style line',
      normalHours: 8, overtimeHours: 1, doubleHours: 0, callouts: 1, updatedBy: tech, updatedAt: '2026-10-28T17:00:00.000Z',
    } as Parameters<typeof attendance.saveEntry>[0]);
    expect(written.normalHours).toBe(8);
    const [stored] = await db.execute<{ workshop: boolean; callout_amount_cents: number; internal_km: string }>(
      sql`select workshop, callout_amount_cents, internal_km from timesheet_entries where id = ${written.id}`,
    );
    expect(stored).toMatchObject({ workshop: false, callout_amount_cents: 0 });
    expect(Number(stored?.internal_km)).toBe(0);

    // What the live release cannot see stays exactly as written.
    const [sent] = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from timesheet_periods where id = ${TIMESHEET.period} and submitted_at is not null`,
    );
    expect(sent?.n).toBe('1');
    const [correction] = await db.execute<{ status: string }>(
      sql`select status from timesheet_corrections where id = ${TIMESHEET.correction}`,
    );
    expect(correction?.status).toBe('accepted');
    const [note] = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from delivery_note_documents where id = ${TIMESHEET.deliveryNote}`,
    );
    expect(note?.n).toBe('1');
  });
});
