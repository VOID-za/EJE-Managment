import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { archivedAt, cents, createdAt, instant, primaryId, rowVersion, updatedAt } from './columns';
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
