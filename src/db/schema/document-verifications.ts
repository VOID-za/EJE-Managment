import { integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { cents, createdAt, instant, primaryId } from './columns';
import { finalDocuments } from './documents';

/**
 * WHAT THE BYTES WERE, WHEN SOMEBODY LOOKED. APPEND-ONLY. BACKUP-1.
 *
 * WHY THIS TABLE EXISTS RATHER THAN A COLUMN UPDATE. `final_documents` carries
 * `size_bytes` and `checksum_sha256`, and for a long time NOTHING WROTE THEM —
 * every row on the live server read `size_bytes = 0` with no checksum. New rows
 * record both at issue now, but the old ones cannot be corrected in place:
 * `final_documents` is WRITE-ONCE and a trigger refuses UPDATE, deliberately,
 * because a job card the customer holds has to stay the job card the customer
 * holds. The trigger's own message says what to do instead — "correct it by
 * adding a new record" — and this is that record.
 *
 * SO A VERIFICATION IS AN OBSERVATION, NOT A CORRECTION. It says "on this date,
 * the file under this key was this many bytes with this hash", or that it was
 * missing, or that it disagreed with the row. `npm run documents:reconcile`
 * writes them; nothing reads them to decide what to serve, because what is
 * served is the file itself.
 *
 * AND IT IS INDEPENDENT EVIDENCE, which is the point. The length and hash are
 * also kept in a sidecar beside the bytes, and that sidecar is on the same disk
 * as the bytes: a bad restore, or anything that rewrites a document, can
 * rewrite its sidecar with it. A record in the database is on different media
 * written by a different process, so the two can be compared — and when they
 * disagree, somebody has lost a document and can be told so.
 */
export const finalDocumentVerifications = pgTable('final_document_verifications', {
  id: primaryId(),
  finalDocumentId: uuid('final_document_id')
    .notNull()
    /*
     * RESTRICT, like every other reference to a historical record: an
     * observation about a document must not be erased by removing the document
     * it is about. `final_documents` itself cascades from `jobs`, which is the
     * one deliberate exception and is not widened here.
     */
    .references(() => finalDocuments.id, { onDelete: 'restrict' }),
  /** Copied rather than joined: the key as it was when this was observed. */
  storageKey: text('storage_key').notNull(),
  /**
   * What the verdict was, in the reconcile's own vocabulary.
   *
   * `text` rather than an enum, for the reason `delivery_attempts.failure_kind`
   * is: a new verdict must not need a migration, and the domain union is what
   * readers narrow against.
   */
  verdict: text('verdict').notNull(),
  /** Null when there were no bytes to measure. */
  sizeBytes: cents('size_bytes'),
  checksumSha256: text('checksum_sha256'),
  rendererVersion: integer('renderer_version'),
  /** One sentence for a person, as the reconcile printed it. Never a credential. */
  detail: text('detail').notNull().default(''),
  verifiedAt: instant('verified_at').notNull(),
  createdAt: createdAt(),
});
