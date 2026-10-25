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

/**
 * ROLLBACK COMPATIBILITY, PHASE 2 OF 2: THE LIVE RELEASE'S OWN CODE.
 *
 * THIS FILE RUNS INSIDE A CHECKOUT OF THE LIVE RELEASE (4634d5d), copied there
 * by `scripts/release/rollback-compat.sh`, so every `@/…` import below is the
 * LIVE code — the repository, the searchability wording and the preflight rule
 * as they are on the server today. It must therefore import only what exists
 * in 4634d5d, and it does: each of these was checked against that commit.
 *
 * The database was migrated to `0030` and populated by THIS release (phase 1).
 * The question is the one a rollback asks: after `0030` has run, does the old
 * code still read, search and write the library — including the
 * "coverage unknown" row only the new code can produce?
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

const id = (value: string): DocumentId => asDocumentId(value);

describePhase('rollback compatibility — phase 2: the live release against a database at 0030', () => {
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
    expect(shipped).toHaveLength(30);
    expect(shipped).not.toContain('0030_library_page_coverage_unknown');

    const rows = await db.execute<{ n: string }>(sql`select count(*)::text as n from drizzle.__drizzle_migrations`);
    const applied = Number(rows[0]?.n);
    // 31 with 0030 alone; more once later migrations (0031 onwards) ship too.
    expect(applied).toBeGreaterThan(30);

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
    const written = await jobs.findByJobNumber('EJE-RB-0031');
    expect(written?.jobType).toBe('test_and_repair');

    await jobs.save(jobFixture('EJE-RB-LIVE'));
    expect((await jobs.findByJobNumber('EJE-RB-LIVE'))?.jobNumber).toBe('EJE-RB-LIVE');
    const [row] = await db.execute<{ date_received: string | null }>(
      sql`select date_received from jobs where job_number = 'EJE-RB-LIVE'`,
    );
    expect(row?.date_received ?? null).toBeNull();
  });
});
