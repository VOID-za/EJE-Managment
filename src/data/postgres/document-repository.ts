import { and, asc, desc, eq, inArray, notInArray, or, sql } from 'drizzle-orm';
import {
  asProvenance,
  asDocumentId,
  asUserId,
  isSearchableState,
  OCR_MAX_ATTEMPTS,
  OCR_STALE_AFTER_MS,
  type DocumentId,
  type DocumentPageMatch,
  type DocumentPageText,
  type DocumentTextIndex,
  type IsoDateTime,
  type OcrJob,
  type OcrJobState,
  type TechnicalDocument,
  type UserId,
} from '@/domain';
import type { DocumentRepository } from '@/data/repositories';
import type { DatabaseExecutor } from '@/db/client';
import * as schema from '@/db/schema';
import { snippetsFor } from '@/lib/text-search';
import { isUuid } from './identifiers';

type DocumentRow = typeof schema.libraryDocuments.$inferSelect;
type VersionRow = typeof schema.libraryDocumentVersions.$inferSelect;

/** How many documents the "recently viewed" strip shows. */
const RECENT_DOCUMENT_LIMIT = 8;

/**
 * The technical library, in PostgreSQL.
 *
 * THE DOMAIN'S UNIT IS A REVISION. `addDocumentVersion` archives the previous
 * `TechnicalDocument` and creates a NEW one with its own id, so a revision is a
 * record in its own right — which is what makes "which revision did the
 * technician work from?" answerable after the fact. This repository keeps that
 * shape: one `library_documents` row per revision, carrying its own
 * `library_document_versions` row with the file.
 *
 * The parent/child split is therefore not used to GROUP revisions here, and
 * deliberately so: the domain has no key that says two revisions are the same
 * document, and inventing one during a persistence migration would be guessing
 * at a relationship the business has not stated. What the child row buys is the
 * file metadata, the approval and rejection columns, and the storage key's
 * uniqueness constraint — which caught a real defect: `library/${fileName}` is
 * not unique across revisions, so two revisions of one manual pointed at one
 * file. `library-operations.ts` now keys by the document id.
 *
 * FAVOURITES AND VIEWS are per person and are rows, not arrays: an unread-style
 * "what did I look at?" query has to be indexed by user.
 */
export class PostgresDocumentRepository implements DocumentRepository {
  constructor(private readonly db: DatabaseExecutor) {}

  async list(): Promise<readonly TechnicalDocument[]> {
    const rows = await this.db
      .select({ document: schema.libraryDocuments, version: schema.libraryDocumentVersions })
      .from(schema.libraryDocuments)
      .innerJoin(
        schema.libraryDocumentVersions,
        eq(schema.libraryDocumentVersions.documentId, schema.libraryDocuments.id),
      )
      .orderBy(desc(schema.libraryDocuments.createdAt));
    return rows.map(toDomainDocument);
  }

  async findById(id: DocumentId): Promise<TechnicalDocument | null> {
    if (!isUuid(id)) return null;
    const rows = await this.db
      .select({ document: schema.libraryDocuments, version: schema.libraryDocumentVersions })
      .from(schema.libraryDocuments)
      .innerJoin(
        schema.libraryDocumentVersions,
        eq(schema.libraryDocumentVersions.documentId, schema.libraryDocuments.id),
      )
      .where(eq(schema.libraryDocuments.id, id))
      .limit(1);
    return rows[0] === undefined ? null : toDomainDocument(rows[0]);
  }

  async save(document: TechnicalDocument): Promise<TechnicalDocument> {
    const documentValues = {
      name: document.name,
      description: document.description,
      documentType: document.documentType,
      manufacturer: document.manufacturer,
      machineModel: document.machineModel,
      tags: [...document.tags] as string[],
      status: document.status,
      provenance: document.provenance,
      archivedAt: document.status === 'archived' ? document.uploadedAt : null,
    } as const;

    await this.db
      .insert(schema.libraryDocuments)
      .values({
        id: document.id,
        ...documentValues,
        createdBy: document.uploadedBy.length === 0 ? null : document.uploadedBy,
      })
      .onConflictDoUpdate({
        target: schema.libraryDocuments.id,
        set: { ...documentValues, updatedAt: sql`now()` },
      });

    const existing = await this.db
      .select({ id: schema.libraryDocumentVersions.id })
      .from(schema.libraryDocumentVersions)
      .where(eq(schema.libraryDocumentVersions.documentId, document.id))
      .limit(1);

    /*
     * `approved_at` is what "current" means to the schema.
     *
     * A partial unique index allows one approved, unarchived version per
     * document, and a technician downloads that one. A pending upload has no
     * approval stamp, which is the same fact the domain's `pending_approval`
     * status states.
     */
    const approvedAt = document.status === 'current' ? document.uploadedAt : null;
    const versionValues = {
      version: document.version,
      fileName: document.fileName,
      storageKey: document.storageKey,
      sizeBytes: document.fileSizeBytes,
      /*
       * MEASURED BY THE STORE, and written here — the column existed and
       * nothing ever filled it. Without it a damaged manual could not be told
       * from a lost one, on the document a technician works from on site.
       */
      checksumSha256: document.checksumSha256,
      pageCount: document.pageCount,
      // Written on the revision AND on the document below: they are allowed to
      // differ, and this is the one somebody downloads.
      provenance: document.provenance,
      uploadedAt: document.uploadedAt,
      uploadedBy: document.uploadedBy.length === 0 ? null : document.uploadedBy,
      approvedAt,
      archivedAt: document.status === 'archived' ? document.uploadedAt : null,
    } as const;

    await this.db
      .insert(schema.libraryDocumentVersions)
      .values({
        id: existing[0]?.id ?? crypto.randomUUID(),
        documentId: document.id,
        ...versionValues,
      })
      .onConflictDoUpdate({
        target: schema.libraryDocumentVersions.id,
        set: { ...versionValues },
      });

    const saved = await this.findById(document.id);
    if (saved === null) throw new Error(`${document.name} vanished during save.`);
    return saved;
  }

  async listFavourites(userId: UserId): Promise<readonly string[]> {
    const rows = await this.db
      .select({ documentId: schema.libraryFavourites.documentId })
      .from(schema.libraryFavourites)
      .where(eq(schema.libraryFavourites.userId, userId))
      .orderBy(desc(schema.libraryFavourites.createdAt));
    return rows.map((row) => row.documentId);
  }

  async toggleFavourite(userId: UserId, documentId: string): Promise<readonly string[]> {
    const existing = await this.db
      .select({ documentId: schema.libraryFavourites.documentId })
      .from(schema.libraryFavourites)
      .where(
        and(
          eq(schema.libraryFavourites.userId, userId),
          eq(schema.libraryFavourites.documentId, documentId),
        ),
      )
      .limit(1);

    if (existing[0] === undefined) {
      await this.db
        .insert(schema.libraryFavourites)
        .values({ userId: userId as string, documentId })
        .onConflictDoNothing();
    } else {
      await this.db
        .delete(schema.libraryFavourites)
        .where(
          and(
            eq(schema.libraryFavourites.userId, userId),
            eq(schema.libraryFavourites.documentId, documentId),
          ),
        );
    }

    return this.listFavourites(userId);
  }

  /**
   * What this person looked at, most recent first, each document once.
   *
   * `distinct on` rather than a grouped query because the ordering is the
   * answer: the strip is "what were you just working on", and a document
   * opened twice is still one document.
   */
  async listRecentlyViewed(userId: UserId): Promise<readonly string[]> {
    const result = await this.db.execute<{ document_id: string }>(sql`
      select distinct on (document_id) document_id, viewed_at
        from library_views
       where user_id = ${userId}
       order by document_id, viewed_at desc
    `);
    const rows = [...result] as { document_id: string; viewed_at: string }[];
    return rows
      .sort((a, b) => b.viewed_at.localeCompare(a.viewed_at))
      .slice(0, RECENT_DOCUMENT_LIMIT)
      .map((row) => row.document_id);
  }

  /**
   * Records a view and trims the tail.
   *
   * Trimmed by the application rather than by the schema, because "the last
   * eight" is a presentation decision — the table would happily keep every view
   * for ever, and a future report may want exactly that.
   */
  async recordView(userId: UserId, documentId: string): Promise<void> {
    await this.db.insert(schema.libraryViews).values({
      id: crypto.randomUUID(),
      userId: userId as string,
      documentId,
      viewedAt: sql`now()`,
    });

    const keep = await this.db
      .select({ id: schema.libraryViews.id })
      .from(schema.libraryViews)
      .where(eq(schema.libraryViews.userId, userId))
      .orderBy(desc(schema.libraryViews.viewedAt))
      .limit(RECENT_DOCUMENT_LIMIT * 4);

    if (keep.length < RECENT_DOCUMENT_LIMIT * 4) return;
    await this.db.delete(schema.libraryViews).where(
      and(
        eq(schema.libraryViews.userId, userId),
        notInArray(
          schema.libraryViews.id,
          keep.map((row) => row.id),
        ),
      ),
    );
  }

  /* ---------------------------------------------------------------------- */
  /* The full-text index. MASTER SCOPE LIB-5.                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Writes a revision's index, REPLACING whatever was there.
   *
   * One upsert on the revision's own id, which is what makes stale searchable
   * text impossible: there is one row per revision and re-extracting overwrites
   * it. The `search` vector is generated by the column, so nothing here can
   * write a vector that disagrees with the text beside it.
   *
   * Text is written ONLY for a state that indexed something, which the table's
   * own CHECK also enforces — a row claiming to be indexed with nothing in it
   * is the failure that would make the search silently find nothing.
   *
   * THE PAGE ROWS GO IN THE SAME CALL. LIB-TEXT-1. Deleted and re-inserted
   * rather than upserted, because a re-extraction with a better engine can
   * produce a DIFFERENT set of pages, and an upsert would leave the pages the
   * new reading did not mention still searchable.
   */
  async saveTextIndex(
    index: DocumentTextIndex,
    content: string,
    pages: readonly (DocumentPageText & { readonly content: string })[] = [],
  ): Promise<DocumentTextIndex> {
    const indexed = isSearchableState(index.state);
    const values = {
      state: index.state,
      // Null unless something was indexed, which is what the CHECK demands.
      source: indexed ? (index.source ?? 'text_layer') : null,
      extractedAt: index.extractedAt,
      characters: indexed ? index.characters : 0,
      pages: index.pages,
      pagesIndexed: indexed ? index.pagesIndexed : 0,
      truncated: index.truncated,
      unreadableStreams: index.unreadableStreams,
      failureReason: index.failureReason,
      content: indexed ? content : '',
    } as const;

    await this.db
      .insert(schema.libraryDocumentText)
      .values({ documentId: index.documentId, ...values })
      .onConflictDoUpdate({
        target: schema.libraryDocumentText.documentId,
        set: { ...values, updatedAt: sql`now()` },
      });

    await this.db
      .delete(schema.libraryDocumentPages)
      .where(eq(schema.libraryDocumentPages.documentId, index.documentId));
    if (pages.length > 0) {
      await this.db.insert(schema.libraryDocumentPages).values(
        pages.map((page) => ({
          documentId: index.documentId,
          pageNumber: page.pageNumber,
          source: page.source,
          characters: page.characters,
          content: page.content,
          extractedAt: index.extractedAt,
        })),
      );
    }

    const saved = await this.findTextIndex(index.documentId);
    if (saved === null) throw new Error(`The index for ${index.documentId} vanished during save.`);
    return saved;
  }

  async findTextIndex(documentId: DocumentId): Promise<DocumentTextIndex | null> {
    if (!isUuid(documentId)) return null;
    const rows = await this.db
      .select()
      .from(schema.libraryDocumentText)
      .where(eq(schema.libraryDocumentText.documentId, documentId))
      .limit(1);
    return rows[0] === undefined ? null : toDomainIndex(rows[0]);
  }

  /**
   * Every revision's index STATE, without its text.
   *
   * The columns are listed rather than selected with `*`: the library screen
   * shows a badge per row, and pulling every manual's full text to render a
   * badge is the kind of read that works in a demonstration and falls over on
   * a real library.
   */
  async listTextIndexes(documentIds?: readonly DocumentId[]): Promise<readonly DocumentTextIndex[]> {
    const wanted = documentIds?.filter((id) => isUuid(id)) ?? null;
    if (wanted !== null && wanted.length === 0) return [];

    const rows = await this.db
      .select({
        documentId: schema.libraryDocumentText.documentId,
        state: schema.libraryDocumentText.state,
        source: schema.libraryDocumentText.source,
        extractedAt: schema.libraryDocumentText.extractedAt,
        characters: schema.libraryDocumentText.characters,
        pages: schema.libraryDocumentText.pages,
        pagesIndexed: schema.libraryDocumentText.pagesIndexed,
        truncated: schema.libraryDocumentText.truncated,
        unreadableStreams: schema.libraryDocumentText.unreadableStreams,
        failureReason: schema.libraryDocumentText.failureReason,
      })
      .from(schema.libraryDocumentText)
      .where(
        wanted === null
          ? undefined
          : inArray(schema.libraryDocumentText.documentId, wanted as string[]),
      );
    return rows.map(toDomainIndex);
  }

  async findTextContent(documentId: DocumentId): Promise<string | null> {
    if (!isUuid(documentId)) return null;
    const rows = await this.db
      .select({ content: schema.libraryDocumentText.content })
      .from(schema.libraryDocumentText)
      .where(eq(schema.libraryDocumentText.documentId, documentId))
      .limit(1);
    return rows[0]?.content ?? null;
  }

  /**
   * The matching revisions, served by the GIN index.
   *
   * `plainto_tsquery('simple', …)` ANDs the terms and does not stem, which is
   * the rule `src/lib/text-search.ts` states and the demonstration store
   * applies in JavaScript — so the two backends agree about what matches. The
   * terms are joined into one query string and passed as a PARAMETER: nothing
   * a person types is ever concatenated into SQL.
   *
   * `ts_rank` orders the page. The candidate set is passed in by the caller,
   * which has already decided what this actor may search — the index is never
   * consulted for a document the application has not cleared.
   */
  async searchTextIds(
    terms: readonly string[],
    documentIds: readonly DocumentId[],
    limit: number,
  ): Promise<readonly DocumentId[]> {
    const allowed = documentIds.filter((id) => isUuid(id));
    if (terms.length === 0 || allowed.length === 0) return [];

    const query = terms.join(' ');
    const documentId = schema.libraryDocumentText.documentId;
    const pages = schema.libraryDocumentPages;

    /*
     * THE PAGES ARE THE INDEX, WHEREVER THERE ARE PAGES. LIB-TEXT-1 (#70).
     *
     * A document read per page is searched through its PAGE vectors, so no
     * single value has to hold the whole book — the reason the old
     * whole-document vector was capped at 400 000 characters, and the reason
     * pages 97–214 of an ordinary manual could not be found. The rule is
     * unchanged: every term must be in the DOCUMENT, so each term is asked of
     * the pages separately — a term on page 3 and another on page 180 still
     * match, exactly as they did when both had to be in the one vector.
     *
     * A document with no page rows (the built-in reader) is searched through
     * the document vector, as before.
     */
    const hasPages = sql`exists (select 1 from ${pages} where ${pages.documentId} = ${documentId})`;
    const everyTermOnSomePage = and(
      ...terms.map(
        (term) =>
          sql`exists (select 1 from ${pages} where ${pages.documentId} = ${documentId}
                and ${pages.search} @@ plainto_tsquery('simple', ${term}))`,
      ),
    );
    const rank = sql<number>`coalesce(
      (select max(ts_rank(${pages.search}, plainto_tsquery('simple', ${query})))
         from ${pages} where ${pages.documentId} = ${documentId}),
      ts_rank(${schema.libraryDocumentText.search}, plainto_tsquery('simple', ${query})))`;

    const rows = await this.db
      .select({ documentId, rank })
      .from(schema.libraryDocumentText)
      .where(
        and(
          inArray(documentId, allowed as string[]),
          inArray(schema.libraryDocumentText.state, ['indexed', 'partially_indexed']),
          or(
            and(hasPages, everyTermOnSomePage),
            and(
              sql`not ${hasPages}`,
              sql`${schema.libraryDocumentText.search} @@ plainto_tsquery('simple', ${query})`,
            ),
          ),
        ),
      )
      .orderBy(desc(rank))
      .limit(limit);

    return rows.map((row) => asDocumentId(row.documentId));
  }

  /**
   * The pages of one revision that match every term, best first. LIB-TEXT-1.
   *
   * The same `plainto_tsquery('simple', ...)` and the same GIN index as the
   * document search, over the per-page vectors, so a page cannot match by a
   * different rule than the document it belongs to. The snippet is built in
   * the application from the page's own text, which is what keeps the
   * highlighting identical on both backends.
   */
  async findPageMatches(
    documentId: DocumentId,
    terms: readonly string[],
    limit: number,
  ): Promise<readonly DocumentPageMatch[]> {
    if (!isUuid(documentId) || terms.length === 0) return [];
    const query = terms.join(' ');

    const rows = await this.db
      .select({
        pageNumber: schema.libraryDocumentPages.pageNumber,
        source: schema.libraryDocumentPages.source,
        characters: schema.libraryDocumentPages.characters,
        content: schema.libraryDocumentPages.content,
      })
      .from(schema.libraryDocumentPages)
      .where(
        and(
          eq(schema.libraryDocumentPages.documentId, documentId),
          sql`${schema.libraryDocumentPages.search} @@ plainto_tsquery('simple', ${query})`,
        ),
      )
      .orderBy(
        desc(
          sql`ts_rank(${schema.libraryDocumentPages.search}, plainto_tsquery('simple', ${query}))`,
        ),
        asc(schema.libraryDocumentPages.pageNumber),
      )
      .limit(limit);

    return rows.map((row) => ({
      documentId,
      pageNumber: row.pageNumber,
      source: row.source as DocumentPageMatch['source'],
      characters: row.characters,
      snippets: snippetsFor(row.content, terms),
    }));
  }

  async listPageText(
    documentId: DocumentId,
  ): Promise<readonly (DocumentPageText & { readonly content: string })[]> {
    if (!isUuid(documentId)) return [];
    const rows = await this.db
      .select({
        pageNumber: schema.libraryDocumentPages.pageNumber,
        source: schema.libraryDocumentPages.source,
        characters: schema.libraryDocumentPages.characters,
        content: schema.libraryDocumentPages.content,
      })
      .from(schema.libraryDocumentPages)
      .where(eq(schema.libraryDocumentPages.documentId, documentId))
      .orderBy(asc(schema.libraryDocumentPages.pageNumber));
    return rows.map((row) => ({
      documentId,
      pageNumber: row.pageNumber,
      source: row.source as DocumentPageText['source'],
      characters: row.characters,
      content: row.content,
    }));
  }

  /* -- work waiting for text recognition. LIB-5 ------------------------- */

  async saveOcrJob(job: OcrJob): Promise<OcrJob> {
    const values = {
      state: job.state,
      attempts: job.attempts,
      queuedAt: job.queuedAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      lastError: job.lastError,
      engine: job.engine,
    } as const;

    await this.db
      .insert(schema.libraryOcrQueue)
      .values({ documentId: job.documentId, ...values })
      .onConflictDoUpdate({
        target: schema.libraryOcrQueue.documentId,
        set: { ...values, updatedAt: sql`now()` },
      });

    const saved = await this.findOcrJob(job.documentId);
    if (saved === null) throw new Error(`The OCR job for ${job.documentId} vanished during save.`);
    return saved;
  }

  async findOcrJob(documentId: DocumentId): Promise<OcrJob | null> {
    if (!isUuid(documentId)) return null;
    const rows = await this.db
      .select()
      .from(schema.libraryOcrQueue)
      .where(eq(schema.libraryOcrQueue.documentId, documentId))
      .limit(1);
    return rows[0] === undefined ? null : toDomainOcrJob(rows[0]);
  }

  async listOcrJobs(states?: readonly OcrJobState[]): Promise<readonly OcrJob[]> {
    const wanted = states ?? null;
    if (wanted !== null && wanted.length === 0) return [];
    const rows = await this.db
      .select()
      .from(schema.libraryOcrQueue)
      .where(wanted === null ? undefined : inArray(schema.libraryOcrQueue.state, [...wanted]))
      .orderBy(asc(schema.libraryOcrQueue.queuedAt));
    return rows.map(toDomainOcrJob);
  }

  /**
   * Takes the oldest claimable job, atomically. ONE WORKER GETS IT.
   *
   * A CONDITIONAL UPDATE, not a read followed by a write. Two workers reading
   * the queue a millisecond apart would both see the same `queued` row, both
   * claim it, and both spend ten minutes reading the same forty-page scan — and
   * then race over whose text is written. The `where` is what makes that
   * impossible: the second UPDATE matches nothing, because the first one has
   * already moved the row out of the state it was looking for.
   *
   * `RETURNING` is what makes it one statement rather than two. Drizzle's
   * `.returning()` compiles to exactly that.
   *
   * THE SUBQUERY PICKS THE OLDEST CLAIMABLE ROW — `queued`, or `running` and
   * stale, because a worker killed mid-page must not strand its document for
   * good — and `FOR UPDATE SKIP LOCKED` means a second worker arriving in the
   * same instant takes the NEXT one instead of waiting for this one.
   */
  async claimOcrJob(now: IsoDateTime): Promise<OcrJob | null> {
    const staleBefore = new Date(Date.parse(now) - OCR_STALE_AFTER_MS).toISOString();

    const claimed = await this.db
      .update(schema.libraryOcrQueue)
      .set({
        state: 'running',
        attempts: sql`${schema.libraryOcrQueue.attempts} + 1`,
        startedAt: now,
        finishedAt: null,
        updatedAt: sql`now()`,
      })
      .where(
        sql`${schema.libraryOcrQueue.documentId} = (
          select q.document_id from library_ocr_queue q
           where q.attempts < ${OCR_MAX_ATTEMPTS}
             and (
               q.state = 'queued'
               -- A failure may be the machine rather than the document: see
               -- isOcrJobClaimable in the domain. The attempt cap bounds it.
               -- (No backticks in here: this is inside a template literal and
               -- one would end the string. Done it once before.)
               or q.state = 'failed'
               -- A worker killed mid-page must not strand its document.
               or (q.state = 'running' and q.started_at <= ${staleBefore})
             )
           order by q.queued_at asc
           limit 1
           for update skip locked
        )`,
      )
      .returning();

    return claimed[0] === undefined ? null : toDomainOcrJob(claimed[0]);
  }
}

const toDomainOcrJob = (row: typeof schema.libraryOcrQueue.$inferSelect): OcrJob => ({
  documentId: asDocumentId(row.documentId),
  // The column's own CHECK keeps this to the five known states.
  state: row.state as OcrJob['state'],
  attempts: row.attempts,
  queuedAt: row.queuedAt,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt,
  lastError: row.lastError,
  engine: row.engine,
});

const toDomainIndex = (row: {
  readonly documentId: string;
  readonly state: string;
  readonly source: string | null;
  readonly extractedAt: string;
  readonly characters: number;
  readonly pages: number;
  readonly pagesIndexed: number;
  readonly truncated: boolean;
  readonly unreadableStreams: number;
  readonly failureReason: string;
}): DocumentTextIndex => ({
  documentId: asDocumentId(row.documentId),
  // The column's own CHECK keeps this to the four known states.
  state: row.state as DocumentTextIndex['state'],
  /*
   * NULL UNLESS SOMETHING WAS INDEXED, which the column's CHECK also enforces.
   * An unrecognised value reads as `text_layer`: it is the only source that
   * existed before OCR, so an old row is what an unknown value will be, and
   * claiming `ocr` would wrongly mark text as lower confidence.
   */
  source: isSearchableState(row.state as DocumentTextIndex['state'])
    ? row.source === 'ocr'
      ? 'ocr'
      : row.source === 'mixed'
        ? 'mixed'
        : 'text_layer'
    : null,
  extractedAt: row.extractedAt,
  characters: row.characters,
  pages: row.pages,
  pagesIndexed: row.pagesIndexed,
  truncated: row.truncated,
  unreadableStreams: row.unreadableStreams,
  failureReason: row.failureReason,
});

const toDomainDocument = ({
  document,
  version,
}: {
  document: DocumentRow;
  version: VersionRow;
}): TechnicalDocument => ({
  id: asDocumentId(document.id),
  name: document.name,
  description: document.description,
  documentType: document.documentType,
  manufacturer: document.manufacturer,
  machineModel: document.machineModel,
  version: version.version,
  status: document.status,
  fileName: version.fileName,
  fileSizeBytes: version.sizeBytes,
  checksumSha256: version.checksumSha256,
  /*
   * ZERO MEANS UNKNOWN, and that is why the `?? 1` went. A metadata-only
   * record has no pages to count, and reporting one page for a manual nobody
   * uploaded is the same fabrication as reporting 2.4 MB for it.
   */
  pageCount: version.pageCount ?? 0,
  storageKey: version.storageKey,
  uploadedAt: version.uploadedAt,
  uploadedBy: asUserId(version.uploadedBy ?? ''),
  tags: document.tags,
  /*
   * THE REVISION'S OWN PROVENANCE, not the document's.
   *
   * They can differ, and the one somebody is looking at is the revision: a
   * genuine manual uploaded as revision 2 of a seeded demonstration record is
   * a real file. An unrecognised value reads as `simulated`, which is the safe
   * direction — a fixture must not pass as EJE's document.
   */
  provenance: asProvenance(version.provenance),
});
