import { and, desc, eq, notInArray, sql } from 'drizzle-orm';
import { asDocumentId, asUserId, type DocumentId, type TechnicalDocument, type UserId } from '@/domain';
import type { DocumentRepository } from '@/data/repositories';
import type { DatabaseExecutor } from '@/db/client';
import * as schema from '@/db/schema';

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
      pageCount: document.pageCount,
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
}

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
  pageCount: version.pageCount ?? 1,
  storageKey: version.storageKey,
  uploadedAt: version.uploadedAt,
  uploadedBy: asUserId(version.uploadedBy ?? ''),
  tags: document.tags,
});
