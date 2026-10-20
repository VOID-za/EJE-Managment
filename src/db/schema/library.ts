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
    check('library_documents_provenance_known', sql`${table.provenance} in ('genuine', 'simulated')`),
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
      sql`${table.provenance} in ('genuine', 'simulated')`,
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
    extractedAt: instant('extracted_at').notNull(),
    characters: integer('characters').notNull().default(0),
    pages: integer('pages').notNull().default(1),
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
    check(
      'library_document_text_state_matches_content',
      sql`(${table.state} = 'indexed' and length(${table.content}) > 0)
          or (${table.state} <> 'indexed' and ${table.content} = '')`,
    ),
    check(
      'library_document_text_state_known',
      sql`${table.state} in ('indexed', 'needs_ocr', 'failed')`,
    ),
  ],
);
