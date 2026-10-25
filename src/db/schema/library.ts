import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  archivedAt,
  cents,
  createdAt,
  instant,
  primaryId,
  provenance,
  rowVersion,
  updatedAt,
} from './columns';
import { libraryDocumentStatus, technicalDocumentType } from './enums';
import { users } from './identity';

/**
 * The technical library: a document's identity and its searchable metadata.
 *
 * Masters and Coordinators add, edit, version, approve or reject, and archive.
 * Technicians view, search, download, favourite, see what they looked at
 * recently, and upload for approval.
 */
export const libraryDocuments = pgTable(
  'library_documents',
  {
    id: primaryId(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    documentType: technicalDocumentType('document_type').notNull(),
    manufacturer: text('manufacturer').notNull().default(''),
    machineModel: text('machine_model').notNull().default(''),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    status: libraryDocumentStatus('status').notNull().default('pending_approval'),
    /** EJE's document, or demonstration data. October mandate §1. */
    provenance: provenance(),

    createdAt: createdAt(),
    createdBy: uuid('created_by').references(() => users.id),
    archivedAt: archivedAt(),
    updatedAt: updatedAt(),
    version: rowVersion(),
  },
  (table) => [
    index('library_documents_name_idx').on(sql`lower(${table.name})`),
    index('library_documents_model_idx').on(sql`lower(${table.machineModel})`),
    index('library_documents_status_idx').on(table.status),
    check('library_documents_provenance_known', sql`${table.provenance} in ('genuine', 'simulated', 'unknown')`),
  ],
);

/**
 * One uploaded revision of a document.
 *
 * The REJECTION path is here, which the demo never had: a Master could approve
 * and archive but not refuse with a reason. A rejected version stays on file so
 * the technician who uploaded it can see why.
 *
 * The FILE lives behind `StorageService`. Nothing is uploaded in this phase.
 */
export const libraryDocumentVersions = pgTable(
  'library_document_versions',
  {
    id: primaryId(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => libraryDocuments.id, { onDelete: 'cascade' }),
    version: text('version').notNull(),

    fileName: text('file_name').notNull(),
    storageKey: text('storage_key').notNull(),
    contentType: text('content_type').notNull().default(''),
    sizeBytes: cents('size_bytes').notNull().default(0),
    pageCount: integer('page_count'),
    checksumSha256: text('checksum_sha256'),

    uploadedAt: instant('uploaded_at').notNull(),
    uploadedBy: uuid('uploaded_by').references(() => users.id),
    /**
     * On the REVISION as well as the document, because they can differ: a
     * genuine manual uploaded as revision 2 of a seeded demonstration record
     * is a real file, and the screen has to say so for the revision somebody
     * is actually looking at.
     */
    provenance: provenance(),
    approvedBy: uuid('approved_by').references(() => users.id),
    approvedAt: instant('approved_at'),
    rejectedBy: uuid('rejected_by').references(() => users.id),
    rejectedAt: instant('rejected_at'),
    rejectionReason: text('rejection_reason').notNull().default(''),
    archivedAt: archivedAt(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('library_document_versions_version_key').on(table.documentId, table.version),
    uniqueIndex('library_document_versions_storage_key_key').on(table.storageKey),
    index('library_document_versions_document_idx').on(table.documentId),
    // One approved, unarchived version is the current one a technician downloads.
    uniqueIndex('library_document_versions_one_current')
      .on(table.documentId)
      .where(sql`${table.approvedAt} is not null and ${table.archivedAt} is null`),
    // Approved and rejected are mutually exclusive outcomes of one review.
    check(
      'library_document_versions_one_outcome',
      sql`${table.approvedAt} is null or ${table.rejectedAt} is null`,
    ),
    check(
      'library_document_versions_provenance_known',
      sql`${table.provenance} in ('genuine', 'simulated', 'unknown')`,
    ),
    check(
      'library_document_versions_rejection_has_reason',
      sql`${table.rejectedAt} is null or btrim(${table.rejectionReason}) <> ''`,
    ),
  ],
);

/** A technician's pinned documents. */
export const libraryFavourites = pgTable(
  'library_favourites',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => libraryDocuments.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('library_favourites_pkey').on(table.userId, table.documentId)],
);

/** What a technician looked at recently. Trimmed by the application, not the schema. */
export const libraryViews = pgTable(
  'library_views',
  {
    id: primaryId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => libraryDocuments.id, { onDelete: 'cascade' }),
    viewedAt: instant('viewed_at').notNull(),
  },
  (table) => [index('library_views_user_idx').on(table.userId, table.viewedAt)],
);

/**
 * PostgreSQL's own full-text type, declared so the index can be described here.
 *
 * Drizzle has no `tsvector`, and the column is GENERATED from `content` — so
 * nothing ever writes to it and the application cannot put it out of step with
 * the text it indexes.
 */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => 'tsvector',
});

/**
 * THE TECHNICAL LIBRARY'S FULL-TEXT INDEX. MASTER SCOPE LIB-5.
 *
 * ONE ROW PER REVISION, keyed by the revision's own id — which is what
 * `library_documents` holds, because the domain's unit is a revision. A new
 * revision therefore indexes itself and cannot inherit, or be shadowed by, the
 * text of the revision it supersedes; and `on delete cascade` means a deleted
 * document takes its searchable text with it rather than leaving words in the
 * index pointing at nothing.
 *
 * WHY THE STATE IS A COLUMN AND NOT AN ABSENCE. A scanned manual has no text:
 * it is `needs_ocr`, which is a fact worth storing — the library shows it, and
 * it is what makes "this document is not searchable yet" sayable instead of
 * leaving a technician to conclude the library has nothing on that machine.
 * `failed` carries the reason an extraction could not be done at all, because
 * an extraction failure that is dropped is a hole nobody knows about.
 *
 * `search` is GENERATED ALWAYS from `content` with the `simple` configuration —
 * no stemming, which is the rule `src/lib/text-search.ts` states and which the
 * demonstration store applies in JavaScript, so the two backends agree about
 * what matches. A GIN index over it is what makes the search a search rather
 * than a scan.
 */
export const libraryDocumentText = pgTable(
  'library_document_text',
  {
    documentId: uuid('document_id')
      .primaryKey()
      .references(() => libraryDocuments.id, { onDelete: 'cascade' }),
    state: text('state').notNull(),
    /**
     * `text_layer`, `ocr` or `mixed`, and only on a row that indexed something.
     * LIB-5, LIB-TEXT-1.
     *
     * Text out of a PDF's text layer is what the document says; text out of
     * recognised pixels is a machine's reading of what it looks like, and a
     * technician searching an electrical diagram for an alarm code needs to
     * know which. `mixed` is a manual that holds both — typeset pages read
     * from the text layer, a scanned diagram recognised afterwards — and the
     * per-page rows say which page is which. The CHECK below ties it to the
     * state so the two cannot drift.
     */
    source: text('source'),
    extractedAt: instant('extracted_at').notNull(),
    characters: integer('characters').notNull().default(0),
    pages: integer('pages').notNull().default(1),
    /**
     * Pages whose text is in the index. LIB-TEXT-1.
     *
     * The CHECK below ties it to the state: equal to `pages` when `indexed`,
     * between 1 and `pages` - 1 when `partially_indexed`, zero otherwise. So
     * "searchable" cannot quietly mean "four of two hundred and fourteen
     * pages", and `partially_indexed` cannot be written for a document that is
     * either wholly in or wholly out of the index.
     */
    pagesIndexed: integer('pages_indexed').notNull().default(0),
    truncated: boolean('truncated').notNull().default(false),
    unreadableStreams: integer('unreadable_streams').notNull().default(0),
    failureReason: text('failure_reason').notNull().default(''),
    /** The extracted text. Empty for every state but `indexed`. */
    content: text('content').notNull().default(''),
    search: tsvector('search').generatedAlwaysAs(
      (): ReturnType<typeof sql> => sql`to_tsvector('simple', content)`,
    ),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('library_document_text_search_idx').using('gin', table.search),
    index('library_document_text_state_idx').on(table.state),
    // `indexed` is the only state that may carry text, and it must carry some:
    // the state and the index can never disagree about whether text exists.
    /*
     * NULL-PROOF, AND THE FIRST VERSION WAS NOT — it accepted an `indexed` row
     * with a NULL source, the row it was written to refuse. `null in (...)` is
     * NULL, so the whole expression came out NULL and a CHECK treats NULL as
     * satisfied. The SECOND time this trap has been hit in this schema; see
     * the migration for the first. An equality between two booleans, and a
     * disjunction whose first arm is true on NULL, are both NULL-free.
     */
    check(
      'library_document_text_source_matches_state',
      sql`(${table.state} in ('indexed', 'partially_indexed')) = (${table.source} is not null)
          and (${table.source} is null or ${table.source} in ('text_layer', 'ocr', 'mixed'))`,
    ),
    check(
      'library_document_text_state_matches_content',
      sql`(${table.state} in ('indexed', 'partially_indexed') and length(${table.content}) > 0)
          or (${table.state} not in ('indexed', 'partially_indexed') and ${table.content} = '')`,
    ),
    check(
      'library_document_text_state_known',
      sql`${table.state} in ('indexed', 'partially_indexed', 'needs_ocr', 'failed')`,
    ),
    /*
     * THE PAGE TALLY AND THE STATE CANNOT DISAGREE. LIB-TEXT-1.
     *
     * `partially_indexed` with every page indexed would be a document
     * understating itself; `indexed` with four pages of two hundred would be
     * one overstating itself, which is the failure this state exists to
     * prevent. Both are refused here rather than trusted to the writer.
     *
     * `partially_indexed` WITH ZERO is "page coverage unknown" — migration
     * `0030`, LIB-TEXT-1 (#70): the built-in reader, cut at its summary budget,
     * cannot tell which pages its text came from, and zero is the truthful
     * number to write. `indexed` still means every page.
     */
    check(
      'library_document_text_pages_indexed_matches_state',
      sql`(${table.state} = 'indexed' and ${table.pagesIndexed} = ${table.pages})
          or (${table.state} = 'partially_indexed'
              and ${table.pagesIndexed} >= 0
              and ${table.pagesIndexed} < ${table.pages})
          or (${table.state} not in ('indexed', 'partially_indexed') and ${table.pagesIndexed} = 0)`,
    ),
  ],
);

/**
 * ONE ROW PER PAGE OF SEARCHABLE TEXT. MASTER SCOPE LIB-TEXT-1.
 *
 * WHY THIS EXISTS ALONGSIDE `library_document_text` RATHER THAN REPLACING IT.
 * The whole-document row is the index a phrase crossing a page break matches,
 * and it is what every existing search and snippet already reads. These rows
 * are ADDITIVE and answer the three questions a single blob cannot:
 *
 *   - WHICH PAGE a result is on, so a technician is sent to page 212 of the
 *     drive manual rather than to the drive manual;
 *   - WHICH PAGES are in the index at all, which is what makes
 *     `partially_indexed` a fact rather than a hedge;
 *   - WHICH PAGES still need recognising, which turns a 214-page manual with
 *     one scanned diagram from 83 minutes of OCR into 25 seconds of it.
 *
 * `source` IS PER PAGE AND NOT PER DOCUMENT, because on a mixed manual the two
 * provenances sit in one file: the typeset pages are what the document says
 * and the recognised page is a machine's reading of what it looks like. A
 * result has to be able to say which it came from.
 *
 * NO ROWS IS A VALID STATE. An engine that cannot attribute text to a page
 * writes none, and the library behaves as it did before — so a deployment
 * without poppler loses the page numbers and nothing else.
 *
 * `search` is GENERATED from `content` with the same `simple` configuration as
 * the document index, so the two can never disagree about what matches.
 */
export const libraryDocumentPages = pgTable(
  'library_document_pages',
  {
    documentId: uuid('document_id')
      .notNull()
      .references(() => libraryDocuments.id, { onDelete: 'cascade' }),
    pageNumber: integer('page_number').notNull(),
    source: text('source').notNull(),
    characters: integer('characters').notNull(),
    content: text('content').notNull(),
    search: tsvector('search').generatedAlwaysAs(
      (): ReturnType<typeof sql> => sql`to_tsvector('simple', content)`,
    ),
    extractedAt: instant('extracted_at').notNull(),
  },
  (table) => [
    uniqueIndex('library_document_pages_pkey').on(table.documentId, table.pageNumber),
    index('library_document_pages_search_idx').using('gin', table.search),
    check('library_document_pages_numbered_from_one', sql`${table.pageNumber} >= 1`),
    check(
      'library_document_pages_source_known',
      sql`${table.source} in ('text_layer', 'ocr')`,
    ),
    /*
     * A PAGE ROW IS A PAGE THAT HAS TEXT. An empty one would be a page claiming
     * to be in the index while contributing nothing to it, which is the same
     * lie the document-level CHECK above refuses.
     */
    check('library_document_pages_content_present', sql`length(${table.content}) > 0`),
    check('library_document_pages_characters_sane', sql`${table.characters} > 0`),
  ],
);

/**
 * WORK WAITING FOR TEXT RECOGNITION. MASTER SCOPE LIB-5.
 *
 * WHY A TABLE AND NOT A FLAG. Lifting a PDF's text layer takes milliseconds and
 * happens inside the upload request, which is right. RECOGNISING a scanned page
 * takes 5 to 15 seconds, so a 214-page manual is twenty minutes to an hour —
 * inside an HTTP request that timed out long ago, holding a transaction open,
 * with the office watching a spinner. The upload records that the document
 * needs recognition and returns; this is what the work is read out of
 * afterwards by something allowed to take as long as it takes.
 *
 * ONE ROW PER REVISION, keyed by it and cascading with it, so a deleted
 * document does not leave work behind for a document that no longer exists.
 *
 * NO STATE HERE MEANS "SEARCHABLE". That question has exactly one answer —
 * `library_document_text.state` — and this table never duplicates it, which is
 * what stops the two disagreeing. `done` means recognition finished and the
 * index was updated; whether the index then says `indexed` is the index's
 * business.
 *
 * `unavailable` IS NOT A FAILURE OF THE DOCUMENT, and is a separate state for
 * exactly that reason: it means no engine is installed on this server, the
 * remedy is an installation rather than a better scan, and the library says so
 * in those words.
 */
export const libraryOcrQueue = pgTable(
  'library_ocr_queue',
  {
    documentId: uuid('document_id')
      .primaryKey()
      .references(() => libraryDocuments.id, { onDelete: 'cascade' }),
    state: text('state').notNull().default('queued'),
    /** Attempts made, including one in flight. Bounds a permanent failure. */
    attempts: integer('attempts').notNull().default(0),
    queuedAt: instant('queued_at').notNull(),
    /** Set while and only while a worker holds it; see the CHECK. */
    startedAt: instant('started_at'),
    finishedAt: instant('finished_at'),
    /** The reason, in words an operator can act on. Never a stack trace. */
    lastError: text('last_error').notNull().default(''),
    /** Which engine produced the outcome, as the engine named itself. */
    engine: text('engine').notNull().default(''),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('library_ocr_queue_state_idx').on(table.state, table.queuedAt),
    check(
      'library_ocr_queue_state_known',
      sql`${table.state} in ('queued', 'running', 'done', 'failed', 'unavailable')`,
    ),
    check('library_ocr_queue_attempts_sane', sql`${table.attempts} >= 0`),
    /*
     * A CLAIMED JOB HAS A START TIME AND AN UNCLAIMED ONE DOES NOT.
     *
     * Without this a `running` row with no `started_at` could never be told
     * from a worker that is still going, so the staleness rule would have
     * nothing to measure and that document would be stuck for good.
     */
    check(
      'library_ocr_queue_running_has_started',
      sql`(${table.state} = 'running') = (${table.startedAt} is not null and ${table.finishedAt} is null)`,
    ),
    check(
      'library_ocr_queue_finished_when_settled',
      sql`(${table.state} in ('done', 'failed', 'unavailable') and ${table.finishedAt} is not null)
          or (${table.state} in ('queued', 'running') and ${table.finishedAt} is null)`,
    ),
  ],
);
