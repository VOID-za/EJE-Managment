import { eq } from 'drizzle-orm';
import { asJobId, asUserId, type IssuedDeliveryNote, type JobId } from '@/domain';
import type { DeliveryNoteRepository } from '@/data/repositories';
import type { DatabaseExecutor } from '@/db/client';
import * as schema from '@/db/schema';

type Row = typeof schema.deliveryNoteDocuments.$inferSelect;

const toDomain = (row: Row): IssuedDeliveryNote => ({
  id: row.id,
  jobId: asJobId(row.jobId),
  fileName: row.fileName,
  storageKey: row.storageKey,
  pageCount: row.pageCount,
  sizeBytes: row.sizeBytes,
  checksumSha256: row.checksumSha256,
  generatedAt: row.generatedAt,
  generatedBy: row.generatedBy === null ? null : asUserId(row.generatedBy),
  jobCardDocumentKey: row.jobCardDocumentKey,
  signedByName: row.signedByName,
  signedAt: row.signedAt,
  signatureSha256: row.signatureSha256,
});

/** Issued courier Delivery Notes, write-once (the table's trigger refuses changes). */
export class PostgresDeliveryNoteRepository implements DeliveryNoteRepository {
  constructor(private readonly db: DatabaseExecutor) {}

  async findByJob(jobId: JobId): Promise<IssuedDeliveryNote | null> {
    const rows = await this.db
      .select()
      .from(schema.deliveryNoteDocuments)
      .where(eq(schema.deliveryNoteDocuments.jobId, jobId))
      .limit(1);
    return rows[0] === undefined ? null : toDomain(rows[0]);
  }

  async record(note: IssuedDeliveryNote): Promise<IssuedDeliveryNote> {
    // One per job: a second insert does nothing, and the first is returned.
    await this.db
      .insert(schema.deliveryNoteDocuments)
      .values({
        id: note.id,
        jobId: note.jobId,
        fileName: note.fileName,
        storageKey: note.storageKey,
        pageCount: note.pageCount,
        sizeBytes: note.sizeBytes,
        checksumSha256: note.checksumSha256,
        generatedAt: note.generatedAt,
        generatedBy: note.generatedBy,
        jobCardDocumentKey: note.jobCardDocumentKey,
        signedByName: note.signedByName,
        signedAt: note.signedAt,
        signatureSha256: note.signatureSha256,
      })
      .onConflictDoNothing({ target: schema.deliveryNoteDocuments.jobId });
    const stored = await this.findByJob(note.jobId);
    if (stored === null) throw new Error(`the delivery note for ${note.jobId} was not recorded`);
    return stored;
  }
}
