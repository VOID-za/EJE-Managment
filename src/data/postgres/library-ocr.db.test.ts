import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  asDocumentId,
  asUserId,
  OCR_MAX_ATTEMPTS,
  type DocumentId,
  type OcrJob,
  type TechnicalDocument,
} from '@/domain';
import type { Database } from '@/db/client';
import * as schema from '@/db/schema';
import { PostgresDocumentRepository } from '@/data/postgres/document-repository';
import { IDS, seedBaseline } from '@/data/postgres/test-fixtures';
import { openTestDatabase, testDatabaseUrl, truncateAll } from '@/data/postgres/test-database';

/**
 * THE OCR QUEUE ON REAL POSTGRESQL. MASTER SCOPE LIB-5.
 *
 * TWO THINGS ONLY THE REAL DATABASE CAN ANSWER, and both of them are the
 * reasons the queue is a table rather than a flag:
 *
 *   - `claimOcrJob` MUST HAND ONE JOB TO ONE CALLER. The demonstration store
 *     gets there through the serialised writer it already has; here it is a
 *     conditional UPDATE with `FOR UPDATE SKIP LOCKED`, and the only way to
 *     know it works is to run two claims at once against a real server. Two
 *     workers on the same forty-page scan is forty pages of wasted time and
 *     then a race over whose text wins.
 *   - THE CONSTRAINTS. `running` with no `started_at` would make a stale claim
 *     unmeasurable and strand its document for good; a settled row with no
 *     `finished_at` would make the queue unreadable. Both are CHECKs, and a
 *     CHECK nobody has tried is a comment.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

const DOCUMENT = asDocumentId('00000000-0000-4000-8000-0000000000d1');
const OTHER = asDocumentId('00000000-0000-4000-8000-0000000000d2');

const document = (id: DocumentId, name: string): TechnicalDocument => ({
  id,
  name,
  description: 'Scanned, with no text layer.',
  documentType: 'machine_manual',
  manufacturer: 'Leadwell',
  machineModel: 'V40',
  version: '1.0',
  status: 'current',
  fileName: `${name}.pdf`,
  fileSizeBytes: 1024,
  checksumSha256: null,
  pageCount: 214,
  storageKey: `uploads/${id}`,
  provenance: 'genuine',
  uploadedAt: '2026-10-01T08:00:00.000Z',
  uploadedBy: asUserId(IDS.master),
  tags: [],
});

const job = (id: DocumentId, over: Partial<OcrJob> = {}): OcrJob => ({
  documentId: id,
  state: 'queued',
  attempts: 0,
  queuedAt: '2026-10-02T08:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  lastError: '',
  engine: '',
  ...over,
});

/** The message PostgreSQL raised, which the driver keeps on the cause. */
const refusalOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error) return cause.message;
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('that statement was expected to be refused, and was not');
};

describeDb('the OCR queue on PostgreSQL', () => {
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
    await repository.save(document(DOCUMENT, 'leadwell-v40'));
    await repository.save(document(OTHER, 'doosan-puma'));
  });

  it('round trips a job', async () => {
    const saved = await repository.saveOcrJob(job(DOCUMENT));

    expect(saved.state).toBe('queued');
    expect(saved.attempts).toBe(0);
    expect(await repository.findOcrJob(DOCUMENT)).toEqual(saved);
  });

  it('HANDS ONE JOB TO ONE CALLER, under two claims at the same instant', async () => {
    await repository.saveOcrJob(job(DOCUMENT));

    /*
     * BOTH AT ONCE, not one after the other. Sequential claims would pass
     * against a read-then-write implementation too, which is exactly the
     * implementation this is here to rule out.
     */
    const [first, second] = await Promise.all([
      repository.claimOcrJob('2026-10-02T09:00:00.000Z'),
      repository.claimOcrJob('2026-10-02T09:00:00.000Z'),
    ]);

    const claimed = [first, second].filter((entry) => entry !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.state).toBe('running');
    expect(claimed[0]?.attempts).toBe(1);
  });

  it('gives two workers two different jobs', async () => {
    await repository.saveOcrJob(job(DOCUMENT));
    await repository.saveOcrJob(job(OTHER, { queuedAt: '2026-10-02T08:00:01.000Z' }));

    const [first, second] = await Promise.all([
      repository.claimOcrJob('2026-10-02T09:00:00.000Z'),
      repository.claimOcrJob('2026-10-02T09:00:00.000Z'),
    ]);

    // `SKIP LOCKED` is what makes the second worker take the NEXT one instead
    // of waiting for the first.
    expect(new Set([first?.documentId, second?.documentId]).size).toBe(2);
  });

  it('takes the oldest first', async () => {
    await repository.saveOcrJob(job(OTHER, { queuedAt: '2026-10-02T08:00:00.000Z' }));
    await repository.saveOcrJob(job(DOCUMENT, { queuedAt: '2026-10-02T09:00:00.000Z' }));

    const claimed = await repository.claimOcrJob('2026-10-02T10:00:00.000Z');
    expect(claimed?.documentId).toBe(OTHER);
  });

  it('re-offers a claim that has gone stale, and counts the attempt', async () => {
    await repository.saveOcrJob(job(DOCUMENT));
    const first = await repository.claimOcrJob('2026-10-02T09:00:00.000Z');
    expect(first?.attempts).toBe(1);

    expect(await repository.claimOcrJob('2026-10-02T09:05:00.000Z')).toBeNull();

    const again = await repository.claimOcrJob('2026-10-02T09:30:00.000Z');
    expect(again?.attempts).toBe(2);
  });

  it('stops offering a job once it has used its attempts', async () => {
    await repository.saveOcrJob(
      job(DOCUMENT, {
        state: 'failed',
        attempts: OCR_MAX_ATTEMPTS,
        finishedAt: '2026-10-02T09:00:00.000Z',
        lastError: 'the scan is blank',
      }),
    );

    expect(await repository.claimOcrJob('2026-10-03T09:00:00.000Z')).toBeNull();
  });

  it('offers a failure again while it is under the cap', async () => {
    await repository.saveOcrJob(
      job(DOCUMENT, {
        state: 'failed',
        attempts: 1,
        finishedAt: '2026-10-02T09:00:00.000Z',
        lastError: 'the disk was full',
      }),
    );

    // A failure may have been the machine rather than the document.
    const claimed = await repository.claimOcrJob('2026-10-02T10:00:00.000Z');
    expect(claimed?.state).toBe('running');
    expect(claimed?.attempts).toBe(2);
  });

  it('does not offer a job whose engine was missing', async () => {
    await repository.saveOcrJob(
      job(DOCUMENT, {
        state: 'unavailable',
        attempts: 1,
        finishedAt: '2026-10-02T09:00:00.000Z',
        lastError: 'no engine',
      }),
    );

    // Nothing has changed; the next attempt would say the same thing.
    expect(await repository.claimOcrJob('2026-10-02T10:00:00.000Z')).toBeNull();
  });

  it('lists by state, oldest first', async () => {
    await repository.saveOcrJob(job(DOCUMENT, { queuedAt: '2026-10-02T09:00:00.000Z' }));
    await repository.saveOcrJob(
      job(OTHER, {
        state: 'done',
        attempts: 1,
        queuedAt: '2026-10-02T08:00:00.000Z',
        finishedAt: '2026-10-02T08:30:00.000Z',
      }),
    );

    expect((await repository.listOcrJobs(['queued'])).map((entry) => entry.documentId)).toEqual([
      DOCUMENT,
    ]);
    expect((await repository.listOcrJobs()).map((entry) => entry.documentId)).toEqual([
      OTHER,
      DOCUMENT,
    ]);
  });

  it('goes with the document it is for', async () => {
    await repository.saveOcrJob(job(DOCUMENT));
    await db.delete(schema.libraryDocuments).where(sql`id = ${DOCUMENT}`);

    // A deleted revision must not leave work behind for a document that no
    // longer exists.
    expect(await repository.findOcrJob(DOCUMENT)).toBeNull();
  });

  describe('what the database refuses', () => {
    it('a RUNNING job with no start time', async () => {
      // Without this the staleness rule has nothing to measure, and a worker
      // killed mid-page strands its document for good.
      expect(
        await refusalOf(
          db.insert(schema.libraryOcrQueue).values({
            documentId: DOCUMENT,
            state: 'running',
            attempts: 1,
            queuedAt: '2026-10-02T08:00:00.000Z',
            startedAt: null,
          }),
        ),
      ).toMatch(/library_ocr_queue_running_has_started/u);
    });

    it('a settled job with no finish time', async () => {
      expect(
        await refusalOf(
          db.insert(schema.libraryOcrQueue).values({
            documentId: DOCUMENT,
            state: 'done',
            attempts: 1,
            queuedAt: '2026-10-02T08:00:00.000Z',
            finishedAt: null,
          }),
        ),
      ).toMatch(/library_ocr_queue_finished_when_settled/u);
    });

    it('a state nobody has heard of', async () => {
      expect(
        await refusalOf(
          db.insert(schema.libraryOcrQueue).values({
            documentId: DOCUMENT,
            state: 'thinking_about_it',
            attempts: 0,
            queuedAt: '2026-10-02T08:00:00.000Z',
          }),
        ),
        /*
         * EITHER CONSTRAINT MAY FIRE FIRST, and which one is PostgreSQL's
         * business. An unknown state is in neither list, so
         * `finished_when_settled` is also violated — asserting one name would
         * be asserting an evaluation order nobody promised.
         */
      ).toMatch(/library_ocr_queue_(state_known|finished_when_settled)/u);
    });
  });

  describe('the text index records where its text came from', () => {
    it('keeps `ocr` apart from `text_layer`', async () => {
      await repository.saveTextIndex(
        {
          documentId: DOCUMENT,
          state: 'indexed',
          source: 'ocr',
          extractedAt: '2026-10-02T09:10:00.000Z',
          characters: 11,
          pages: 40,
          pagesIndexed: 40,
          truncated: true,
          unreadableStreams: 0,
          failureReason: '',
        },
        'ALARM 750',
      );

      const read = await repository.findTextIndex(DOCUMENT);
      expect(read?.source).toBe('ocr');
      expect(read?.truncated).toBe(true);
    });

    it('carries NO source on a row that is not indexed', async () => {
      await repository.saveTextIndex(
        {
          documentId: DOCUMENT,
          state: 'needs_ocr',
          source: null,
          extractedAt: '2026-10-02T09:10:00.000Z',
          characters: 0,
          pages: 214,
          pagesIndexed: 0,
          truncated: false,
          unreadableStreams: 0,
          failureReason: 'This PDF carries no extractable text.',
        },
        '',
      );

      expect((await repository.findTextIndex(DOCUMENT))?.source).toBeNull();
    });

    it('refuses a source on a row with no text, by CHECK', async () => {
      expect(
        await refusalOf(
          db.insert(schema.libraryDocumentText).values({
            documentId: DOCUMENT,
            state: 'needs_ocr',
            source: 'ocr',
            extractedAt: '2026-10-02T09:10:00.000Z',
            content: '',
          }),
        ),
      ).toMatch(/library_document_text_source_matches_state/u);
    });

    it('refuses an INDEXED row with no source, by CHECK', async () => {
      expect(
        await refusalOf(
          db.insert(schema.libraryDocumentText).values({
            documentId: DOCUMENT,
            state: 'indexed',
            source: null,
            extractedAt: '2026-10-02T09:10:00.000Z',
            content: 'some text',
            // The page tally is made to AGREE with the state, so the only rule
            // this row breaks is the one under test. LIB-TEXT-1 added a second
            // CHECK that an `indexed` row with the default `pages_indexed` of
            // zero also breaks, and a test that accepted either message would
            // have stopped discriminating.
            pages: 1,
            pagesIndexed: 1,
          }),
        ),
      ).toMatch(/library_document_text_source_matches_state/u);
    });
  });

  /* -- the page index. LIB-TEXT-1 ---------------------------------------- */

  describe('the per-page index', () => {
    it('round trips a page, its provenance and its own search vector', async () => {
      const repository = new PostgresDocumentRepository(db);
      await repository.saveTextIndex(
        {
          documentId: DOCUMENT,
          state: 'partially_indexed',
          source: 'text_layer',
          extractedAt: '2026-10-02T09:10:00.000Z',
          characters: 40,
          pages: 3,
          pagesIndexed: 2,
          truncated: false,
          unreadableStreams: 0,
          failureReason: 'No text could be read from page 2.',
        },
        'ALARM 414 HYDRAULIC PRESSURE\n\nTORQUE SETTINGS MAST BOLTS',
        [
          {
            documentId: DOCUMENT,
            pageNumber: 1,
            source: 'text_layer',
            characters: 28,
            content: 'ALARM 414 HYDRAULIC PRESSURE',
          },
          {
            documentId: DOCUMENT,
            pageNumber: 3,
            source: 'ocr',
            characters: 26,
            content: 'TORQUE SETTINGS MAST BOLTS',
          },
        ],
      );

      const pages = await repository.listPageText(DOCUMENT);
      expect(pages.map((page) => [page.pageNumber, page.source])).toEqual([
        [1, 'text_layer'],
        [3, 'ocr'],
      ]);

      /*
       * THE GENERATED VECTOR IS WHAT SERVES THE SEARCH, so the match comes out
       * of PostgreSQL's own index rather than a JavaScript scan — and the page
       * number it names is the document's.
       */
      const matches = await repository.findPageMatches(DOCUMENT, ['torque'], 5);
      expect(matches.map((match) => match.pageNumber)).toEqual([3]);
      expect(matches[0]?.source).toBe('ocr');
      expect(matches[0]?.snippets.join(' ')).toMatch(/torque/iu);
    });

    it('REPLACES the pages on a re-extraction, leaving none of the old ones', async () => {
      const repository = new PostgresDocumentRepository(db);
      const index = {
        documentId: DOCUMENT,
        state: 'indexed' as const,
        source: 'text_layer' as const,
        extractedAt: '2026-10-02T09:10:00.000Z',
        characters: 10,
        pages: 1,
        pagesIndexed: 1,
        truncated: false,
        unreadableStreams: 0,
        failureReason: '',
      };

      await repository.saveTextIndex(index, 'OLD TEXT', [
        {
          documentId: DOCUMENT,
          pageNumber: 1,
          source: 'text_layer',
          characters: 8,
          content: 'OLD TEXT',
        },
      ]);
      await repository.saveTextIndex(index, 'NEW TEXT', [
        {
          documentId: DOCUMENT,
          pageNumber: 1,
          source: 'text_layer',
          characters: 8,
          content: 'NEW TEXT',
        },
      ]);

      // Stale searchable text is the defect this design exists to prevent.
      expect(await repository.findPageMatches(DOCUMENT, ['old'], 5)).toEqual([]);
      expect((await repository.findPageMatches(DOCUMENT, ['new'], 5)).length).toBe(1);
      expect((await repository.listPageText(DOCUMENT)).length).toBe(1);
    });

    it('refuses an EMPTY page, a page zero and an unknown source, by CHECK', async () => {
      const common = {
        documentId: DOCUMENT,
        extractedAt: '2026-10-02T09:10:00.000Z',
      } as const;

      expect(
        await refusalOf(
          db.insert(schema.libraryDocumentPages).values({
            ...common,
            pageNumber: 1,
            source: 'text_layer',
            characters: 1,
            content: '',
          }),
        ),
      ).toMatch(/library_document_pages_content_present/u);

      expect(
        await refusalOf(
          db.insert(schema.libraryDocumentPages).values({
            ...common,
            pageNumber: 0,
            source: 'text_layer',
            characters: 1,
            content: 'x',
          }),
        ),
      ).toMatch(/library_document_pages_numbered_from_one/u);

      expect(
        await refusalOf(
          db.insert(schema.libraryDocumentPages).values({
            ...common,
            pageNumber: 1,
            source: 'guessed',
            characters: 1,
            content: 'x',
          }),
        ),
      ).toMatch(/library_document_pages_source_known/u);
    });

    it('refuses a page tally that disagrees with the state, by CHECK', async () => {
      /*
       * BOTH DIRECTIONS. `indexed` with four pages of two hundred would be a
       * document OVERSTATING what is searchable — the failure the partial
       * state exists to prevent — and `partially_indexed` with every page
       * indexed would be one understating itself.
       */
      expect(
        await refusalOf(
          db.insert(schema.libraryDocumentText).values({
            documentId: DOCUMENT,
            state: 'indexed',
            source: 'text_layer',
            extractedAt: '2026-10-02T09:10:00.000Z',
            content: 'some text',
            pages: 200,
            pagesIndexed: 4,
          }),
        ),
      ).toMatch(/library_document_text_pages_indexed_matches_state/u);

      expect(
        await refusalOf(
          db.insert(schema.libraryDocumentText).values({
            documentId: DOCUMENT,
            state: 'partially_indexed',
            source: 'text_layer',
            extractedAt: '2026-10-02T09:10:00.000Z',
            content: 'some text',
            pages: 4,
            pagesIndexed: 4,
          }),
        ),
      ).toMatch(/library_document_text_pages_indexed_matches_state/u);
    });

    it('takes its pages with it when the revision is deleted', async () => {
      const repository = new PostgresDocumentRepository(db);
      await repository.saveTextIndex(
        {
          documentId: DOCUMENT,
          state: 'indexed',
          source: 'text_layer',
          extractedAt: '2026-10-02T09:10:00.000Z',
          characters: 8,
          pages: 1,
          pagesIndexed: 1,
          truncated: false,
          unreadableStreams: 0,
          failureReason: '',
        },
        'SOME TEXT',
        [
          {
            documentId: DOCUMENT,
            pageNumber: 1,
            source: 'text_layer',
            characters: 9,
            content: 'SOME TEXT',
          },
        ],
      );

      await db.delete(schema.libraryDocuments).where(eq(schema.libraryDocuments.id, DOCUMENT));

      // Words in the index pointing at a document that no longer exists would
      // be a search that answers with nothing openable.
      const left = await db
        .select()
        .from(schema.libraryDocumentPages)
        .where(eq(schema.libraryDocumentPages.documentId, DOCUMENT));
      expect(left).toEqual([]);
    });
  });
});
