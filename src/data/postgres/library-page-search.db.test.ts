import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { asDocumentId, asUserId, type DocumentId, type DocumentTextIndex, type TechnicalDocument } from '@/domain';
import type { Database } from '@/db/client';
import * as schema from '@/db/schema';
import { PostgresDocumentRepository } from '@/data/postgres/document-repository';
import { IDS, seedBaseline } from '@/data/postgres/test-fixtures';
import { openTestDatabase, testDatabaseUrl, truncateAll } from '@/data/postgres/test-database';

/**
 * LIB-TEXT-1 (#70) — THE PAGES ARE THE INDEX, ON PostgreSQL.
 *
 * What only the real database can prove:
 *
 *  - A 1 200-PAGE DOCUMENT IS STORED AND SEARCHED. Its page text is several
 *    megabytes; the document-level `content` holds only the bounded summary,
 *    which is what keeps its generated tsvector inside PostgreSQL's limit —
 *    the reason the old whole-document budget existed at all.
 *  - A TERM ON PAGE 1 100 IS FOUND, through the per-page vectors, though the
 *    summary ends a hundred pages in.
 *  - EVERY TERM MUST BE IN THE DOCUMENT, NOT ON ONE PAGE — terms on pages 3
 *    and 1 150 match, as they did when both had to be in one vector; a term
 *    nowhere in the document does not.
 *  - A DOCUMENT WITH NO PAGE ROWS (the built-in reader) is still searched
 *    through its document vector.
 *  - MIGRATION 0030: a partial index may record its page coverage as unknown
 *    (0 of M); `indexed` still may not claim fewer pages than the document has.
 *
 * Run with `npm run db:test`. Skipped where there is no `TEST_DATABASE_URL`.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

const BIG = asDocumentId('00000000-0000-4000-8000-0000000000e1');
const SMALL = asDocumentId('00000000-0000-4000-8000-0000000000e2');
const PAGES = 1_200;
const SUMMARY_CHARACTERS = 400_000;

const marker = (page: number): string => `pagemark${page}x`;

/** About 3 kB of text — 45 lines of alarm text — with its own marker. */
const pageText = (page: number): string =>
  [
    `Section ${page} ${marker(page)}`,
    ...Array.from(
      { length: 44 },
      (_unused, line) =>
        `Alarm ${page}-${line + 1}: check the spindle drive parameter P${line + 1} before restart.`,
    ),
  ].join('\n');

const document = (id: DocumentId, name: string, pageCount: number): TechnicalDocument => ({
  id,
  name,
  description: 'A long manual.',
  documentType: 'service_manual',
  manufacturer: 'Leadwell',
  machineModel: 'V40',
  version: '1.0',
  status: 'current',
  fileName: `${name}.pdf`,
  fileSizeBytes: 1024,
  checksumSha256: null,
  pageCount,
  storageKey: `uploads/${id}`,
  provenance: 'genuine',
  uploadedAt: '2026-10-01T08:00:00.000Z',
  uploadedBy: asUserId(IDS.master),
  tags: [],
});

const index = (documentId: DocumentId, over: Partial<DocumentTextIndex> = {}): DocumentTextIndex => ({
  documentId,
  state: 'indexed',
  source: 'text_layer',
  extractedAt: '2026-10-25T08:00:00.000Z',
  characters: 1,
  pages: 1,
  pagesIndexed: 1,
  truncated: false,
  unreadableStreams: 0,
  failureReason: '',
  ...over,
});

const refusalOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    let current: unknown = error;
    const said: string[] = [];
    for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
      said.push(current.message);
      current = (current as { cause?: unknown }).cause;
    }
    return said.join(' | ');
  }
  throw new Error('that statement was expected to be refused, and was not');
};

describeDb('the library searched page by page, on PostgreSQL', () => {
  let db: Database;
  let repository: PostgresDocumentRepository;

  beforeAll(async () => {
    db = await openTestDatabase(url ?? '');
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seedBaseline(db);
    repository = new PostgresDocumentRepository(db);
    await repository.save(document(BIG, 'leadwell-v40-complete', PAGES));
    await repository.save(document(SMALL, 'doosan-puma-quick-guide', 2));

    const pages = Array.from({ length: PAGES }, (_unused, offset) => {
      const content = pageText(offset + 1);
      return {
        documentId: BIG,
        pageNumber: offset + 1,
        source: 'text_layer' as const,
        characters: content.length,
        content,
      };
    });
    const whole = pages.map((page) => page.content).join('\n\n');
    await repository.saveTextIndex(
      index(BIG, {
        pages: PAGES,
        pagesIndexed: PAGES,
        characters: pages.reduce((sum, page) => sum + page.characters, 0),
      }),
      whole.slice(0, SUMMARY_CHARACTERS),
      pages,
    );

    // The built-in reader: a document vector and no page rows.
    await repository.saveTextIndex(
      index(SMALL, { pages: 2, pagesIndexed: 2, characters: 60 }),
      'Quick guide. Coolant pressure alarm 2071 means the filter is blocked.',
      [],
    );
  }, 120_000);

  it('stores all 1 200 pages — megabytes of text — with only the bounded summary on the document', async () => {
    const rows = await db
      .select({ pageNumber: schema.libraryDocumentPages.pageNumber })
      .from(schema.libraryDocumentPages)
      .where(eq(schema.libraryDocumentPages.documentId, BIG));
    expect(rows).toHaveLength(PAGES);

    const saved = await repository.findTextIndex(BIG);
    // Exactly the page text written — about 3.6 million characters, roughly nine times
    // the old 400 000-character whole-document budget.
    const written = Array.from({ length: PAGES }, (_unused, offset) => pageText(offset + 1).length)
      .reduce((sum, length) => sum + length, 0);
    expect(saved?.characters).toBe(written);
    expect(written).toBeGreaterThan(8 * SUMMARY_CHARACTERS);
    expect((await repository.findTextContent(BIG))?.length).toBeLessThanOrEqual(SUMMARY_CHARACTERS);
  });

  it('finds a term that is only on page 1 100, far past the end of the summary', async () => {
    expect(await repository.searchTextIds([marker(1_100)], [BIG, SMALL], 10)).toEqual([BIG]);
    const pages = await repository.findPageMatches(BIG, [marker(1_100)], 5);
    expect(pages.map((page) => page.pageNumber)).toEqual([1_100]);
  });

  it('matches terms on DIFFERENT pages, and refuses a term that is nowhere in the document', async () => {
    expect(await repository.searchTextIds([marker(3), marker(1_150)], [BIG], 10)).toEqual([BIG]);
    expect(await repository.searchTextIds([marker(3), 'nowhereinthisbook'], [BIG], 10)).toEqual([]);
  });

  it('still searches a document with NO page rows through its document text', async () => {
    expect(await repository.searchTextIds(['coolant', '2071'], [BIG, SMALL], 10)).toEqual([SMALL]);
  });

  it('only searches the candidates it was given', async () => {
    expect(await repository.searchTextIds([marker(1_100)], [SMALL], 10)).toEqual([]);
  });

  it('MIGRATION 0030: accepts a partial index whose page coverage is unknown (0 of M)', async () => {
    const saved = await repository.saveTextIndex(
      index(SMALL, { state: 'partially_indexed', pages: 214, pagesIndexed: 0, truncated: true }),
      'The first part of a long manual, read without poppler.',
      [],
    );
    expect(saved.state).toBe('partially_indexed');
    expect(saved.pagesIndexed).toBe(0);
  });

  it('…and still refuses `indexed` claiming fewer pages than the document has', async () => {
    const refusal = await refusalOf(
      repository.saveTextIndex(
        index(SMALL, { state: 'indexed', pages: 214, pagesIndexed: 96, truncated: true }),
        'Ninety-six pages of a two-hundred-and-fourteen page manual.',
        [],
      ),
    );
    expect(refusal).toContain('library_document_text_pages_indexed_matches_state');
  });
});
