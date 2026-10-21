import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { asDocumentId, asUserId, type DocumentTextIndex, type TechnicalDocument } from '@/domain';
import type { Database } from '@/db/client';
import * as schema from '@/db/schema';
import { matchesAllTerms, searchTerms } from '@/lib/text-search';
import { PostgresDocumentRepository } from './document-repository';
import { openTestDatabase, testDatabaseUrl, truncateAll } from './test-database';
import { IDS, seedBaseline } from './test-fixtures';

/**
 * THE LIBRARY'S FULL-TEXT INDEX, ON REAL POSTGRESQL. MASTER SCOPE LIB-5.
 *
 * The things only a database can answer for:
 *
 *  1. THE GENERATED `tsvector` AND ITS GIN INDEX actually serve the search —
 *     the column is computed by PostgreSQL from the text, so nothing the
 *     application writes can put the two out of step.
 *  2. THE TWO BACKENDS AGREE. The same queries are run through the repository
 *     and through `matchesAllTerms`, which is what the demonstration store
 *     uses, and the answers must match: whole words, every term, no stemming.
 *  3. THE CONSTRAINTS HOLD. A row claiming to be `indexed` with no text, or
 *     carrying text while claiming not to be indexed, is refused by the
 *     database — it is the state in which a search silently finds nothing.
 *  4. A DELETED DOCUMENT TAKES ITS TEXT WITH IT, so no words are left in the
 *     index pointing at a document that is gone.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

const MANUAL =
  'Alarm 414 indicates a servo amplifier fault on the Z axis. Measure the DC link voltage before replacing the drive module. The boiler room is elsewhere.';

describeDb('the technical library full-text index', () => {
  let db: Database;
  let documents: PostgresDocumentRepository;

  beforeAll(async () => {
    db = await openTestDatabase(url ?? '');
  });

  afterAll(async () => {
    await db.execute(sql`select 1`);
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seedBaseline(db);
    documents = new PostgresDocumentRepository(db);
  });

  const newDocument = (over: Partial<TechnicalDocument> = {}): TechnicalDocument => {
    const id = asDocumentId(crypto.randomUUID());
    return {
      id,
      name: 'Fanuc 0i-MF alarm list',
      description: 'Alarm codes.',
      documentType: 'service_manual',
      manufacturer: 'Fanuc',
      machineModel: '0i-MF',
      version: '1.0',
      status: 'current',
      fileName: 'alarms.pdf',
      fileSizeBytes: 120_000,
      pageCount: 12,
      storageKey: `library/${id}/alarms.pdf`,
      uploadedAt: '2026-10-01T08:00:00.000Z',
      uploadedBy: asUserId(IDS.master),
      tags: ['alarms'],
      provenance: 'genuine' as const,
      ...over,
    };
  };

  const index = (
    documentId: TechnicalDocument['id'],
    over: Partial<DocumentTextIndex> = {},
  ): DocumentTextIndex => ({
    documentId,
    state: 'indexed',
    source: 'text_layer',
    extractedAt: '2026-10-01T08:00:05.000Z',
    characters: MANUAL.length,
    pages: 12,
    truncated: false,
    unreadableStreams: 0,
    failureReason: '',
    ...over,
  });

  it('round trips an index and its text', async () => {
    const document = await documents.save(newDocument());
    const saved = await documents.saveTextIndex(index(document.id), MANUAL);

    expect(saved.state).toBe('indexed');
    expect(saved.characters).toBe(MANUAL.length);
    expect(await documents.findTextContent(document.id)).toBe(MANUAL);

    const states = await documents.listTextIndexes([document.id]);
    expect(states).toHaveLength(1);
    expect(states[0]?.pages).toBe(12);
  });

  it('serves the search from the generated vector, and agrees with the shared rule', async () => {
    const document = await documents.save(newDocument());
    await documents.saveTextIndex(index(document.id), MANUAL);

    for (const query of ['servo amplifier', 'DC link', 'alarm 414', 'boiler']) {
      const terms = searchTerms(query);
      const ids = await documents.searchTextIds(terms, [document.id], 10);
      expect(ids.length > 0, `postgres on "${query}"`).toBe(matchesAllTerms(MANUAL, terms));
    }

    // Every term, not any of them — and whole words, so "oil" misses "boiler".
    for (const query of ['servo hydraulic', 'oil', 'meggered']) {
      const terms = searchTerms(query);
      const ids = await documents.searchTextIds(terms, [document.id], 10);
      expect(ids, `postgres on "${query}"`).toHaveLength(0);
      expect(matchesAllTerms(MANUAL, terms), `shared rule on "${query}"`).toBe(false);
    }
  });

  it('uses the GIN index rather than scanning the table', async () => {
    const document = await documents.save(newDocument());
    await documents.saveTextIndex(index(document.id), MANUAL);

    /*
     * The plan is asserted because the index is the whole point: a search that
     * works by reading every manual is a search that stops working when EJE
     * have a thousand of them. `enable_seqscan` is turned off around this one
     * statement, which is what makes the planner's CHOICE legible on a table
     * holding a single row — on a table this small a sequential scan is
     * genuinely cheaper, and would tell us nothing about the index existing.
     */
    await db.execute(sql`set enable_seqscan = off`);
    const plan = await db.execute<{ 'QUERY PLAN': string }>(sql`
      explain select document_id from library_document_text
       where search @@ plainto_tsquery('simple', 'servo amplifier')
    `);
    const text = [...plan].map((row) => row['QUERY PLAN']).join('\n');
    // Back on: the connection is shared with every other test in this file.
    await db.execute(sql`set enable_seqscan = on`);
    expect(text).toMatch(/library_document_text_search_idx/);
  });

  it('replaces a revision’s text rather than leaving the old words searchable', async () => {
    const document = await documents.save(newDocument());
    await documents.saveTextIndex(index(document.id), MANUAL);
    expect(await documents.searchTextIds(searchTerms('servo amplifier'), [document.id], 10)).toHaveLength(1);

    const replacement = 'Revision two covers the spindle encoder only.';
    await documents.saveTextIndex(
      index(document.id, { characters: replacement.length }),
      replacement,
    );

    expect(await documents.findTextContent(document.id)).toBe(replacement);
    expect(await documents.searchTextIds(searchTerms('servo amplifier'), [document.id], 10)).toHaveLength(0);
    expect(await documents.searchTextIds(searchTerms('spindle encoder'), [document.id], 10)).toHaveLength(1);
  });

  it('keeps no text for a document that needs OCR, and returns it from no search', async () => {
    const document = await documents.save(newDocument());
    await documents.saveTextIndex(
      index(document.id, {
        state: 'needs_ocr',
        characters: 0,
        failureReason: 'No text could be extracted: the pages are images.',
      }),
      // Even if a caller passes text, a state that is not `indexed` stores none.
      MANUAL,
    );

    expect(await documents.findTextContent(document.id)).toBe('');
    expect(await documents.searchTextIds(searchTerms('servo amplifier'), [document.id], 10)).toHaveLength(0);
    const [state] = await documents.listTextIndexes([document.id]);
    expect(state?.state).toBe('needs_ocr');
    expect(state?.failureReason).toMatch(/images/);
  });

  it('refuses a row whose state and content disagree', async () => {
    const document = await documents.save(newDocument());

    // `indexed` with nothing in it: the state in which a search silently finds
    // nothing and looks like it worked.
    await expect(
      db.insert(schema.libraryDocumentText).values({
        documentId: document.id,
        state: 'indexed',
        extractedAt: '2026-10-01T08:00:00.000Z',
        content: '',
      }),
    ).rejects.toThrow();

    // And the other way round: text filed under a state that says there is none.
    await expect(
      db.insert(schema.libraryDocumentText).values({
        documentId: document.id,
        state: 'needs_ocr',
        extractedAt: '2026-10-01T08:00:00.000Z',
        content: MANUAL,
      }),
    ).rejects.toThrow();

    // A state nobody defined.
    await expect(
      db.insert(schema.libraryDocumentText).values({
        documentId: document.id,
        state: 'pending',
        extractedAt: '2026-10-01T08:00:00.000Z',
        content: '',
      }),
    ).rejects.toThrow();
  });

  it('takes the searchable text with the document when it is deleted', async () => {
    const document = await documents.save(newDocument());
    await documents.saveTextIndex(index(document.id), MANUAL);

    await db.delete(schema.libraryDocuments).where(eq(schema.libraryDocuments.id, document.id));
    expect(await documents.findTextIndex(document.id)).toBeNull();
    expect(await documents.listTextIndexes()).toHaveLength(0);
  });

  it('never consults the index for a document the caller did not clear', async () => {
    const allowed = await documents.save(newDocument());
    const other = await documents.save(newDocument({ name: 'Another manual' }));
    await documents.saveTextIndex(index(allowed.id), MANUAL);
    await documents.saveTextIndex(index(other.id), MANUAL);

    const ids = await documents.searchTextIds(searchTerms('servo amplifier'), [allowed.id], 10);
    expect(ids).toEqual([allowed.id]);
  });
});
