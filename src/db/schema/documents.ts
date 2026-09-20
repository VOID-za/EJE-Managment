import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { cents, createdAt, instant, primaryId } from './columns';
import { deliveryState, outboxChannel } from './enums';
import { jobs } from './jobs';
import { users } from './identity';

/**
 * The document the customer holds. WRITE-ONCE.
 *
 * Rendered once, when the job card is issued, and every later view or download
 * returns those same bytes. There is no code path that regenerates it from
 * current job data, and this table has no `updated_at` by design.
 *
 * THE BYTES ARE NOT HERE. They live behind `StorageService`; this row holds the
 * key, the checksum and enough metadata to prove the file is the file that was
 * issued. Putting a PDF in a column would make every backup of the database a
 * backup of every document, and would make the row the truth rather than the
 * file.
 */
export const finalDocuments = pgTable(
  'final_documents',
  {
    id: primaryId(),
    /** One issued document per job. The unique index is what makes that true. */
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    fileName: text('file_name').notNull(),
    storageKey: text('storage_key').notNull(),
    contentType: text('content_type').notNull().default('application/pdf'),
    pageCount: integer('page_count').notNull(),
    sizeBytes: cents('size_bytes').notNull().default(0),
    /** Verified on every read. A mismatch is an error, never a silently wrong job card. */
    checksumSha256: text('checksum_sha256'),
    /**
     * Which renderer produced these bytes.
     *
     * Bytes written when a job card was ISSUED are the historical document and
     * are never re-rendered whatever this says. It exists so a BACKFILL of
     * seeded history — which never had an issue event — can be refreshed when
     * the renderer is fixed.
     */
    rendererVersion: integer('renderer_version').notNull(),
    /** True when these bytes are a cache for history rather than an issued document. */
    backfilled: boolean('backfilled').notNull().default(false),
    generatedAt: instant('generated_at').notNull(),
    generatedBy: uuid('generated_by').references(() => users.id),
    /** The address the document was issued to, recorded as it was at the time. */
    issuedTo: text('issued_to').notNull().default(''),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('final_documents_job_key').on(table.jobId),
    uniqueIndex('final_documents_storage_key_key').on(table.storageKey),
    check('final_documents_page_count_positive', sql`${table.pageCount} >= 1`),
  ],
);

/**
 * Every attempt to get the customer's copy to them. APPEND-ONLY.
 *
 * One row per attempt, not a counter. The question the office asks is "we tried
 * three times — what did the provider say each time?", and a counter cannot
 * answer it.
 *
 * `state` is the honest one: a provider ACCEPTING a send is `pending_delivery`,
 * never `delivered`. Only a confirmation makes it `delivered`, and only
 * `delivered` closes the job.
 */
export const deliveryAttempts = pgTable(
  'delivery_attempts',
  {
    id: primaryId(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    finalDocumentId: uuid('final_document_id').references(() => finalDocuments.id),
    channel: outboxChannel('channel').notNull(),
    recipient: text('recipient').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    state: deliveryState('state').notNull(),
    /** The provider's id, used to ask what became of it later. */
    providerMessageId: text('provider_message_id'),
    attemptedAt: instant('attempted_at').notNull(),
    acceptedAt: instant('accepted_at'),
    confirmedAt: instant('confirmed_at'),
    failedAt: instant('failed_at'),
    failureReason: text('failure_reason').notNull().default(''),
    /** When the worker should try again. Null when it should not. */
    nextAttemptAt: instant('next_attempt_at'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('delivery_attempts_job_attempt_key').on(
      table.jobId,
      table.channel,
      table.attemptNumber,
    ),
    index('delivery_attempts_job_idx').on(table.jobId, table.attemptNumber),
    index('delivery_attempts_provider_idx')
      .on(table.providerMessageId)
      .where(sql`${table.providerMessageId} is not null`),
    check('delivery_attempts_attempt_positive', sql`${table.attemptNumber} >= 1`),
    // Only a confirmation may claim delivery.
    check(
      'delivery_attempts_delivered_is_confirmed',
      sql`${table.state} <> 'delivered' or ${table.confirmedAt} is not null`,
    ),
  ],
);

/**
 * Messages waiting to go out. The transactional outbox.
 *
 * NOTHING IN THIS PHASE SENDS ANYTHING. The table exists so the operation that
 * issues a job card can insert a row INSIDE its transaction, and a worker can
 * send it after the commit. That ordering is what stops a rolled-back issue
 * from having already emailed a customer.
 *
 * `idempotency_key` is unique, so a worker crash mid-send cannot produce two
 * emails.
 */
export const messageOutbox = pgTable(
  'message_outbox',
  {
    id: primaryId(),
    idempotencyKey: text('idempotency_key').notNull(),
    channel: outboxChannel('channel').notNull(),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),

    /** Email: addresses. WhatsApp: a single msisdn. */
    recipients: text('recipients').array().notNull(),
    ccRecipients: text('cc_recipients').array().notNull().default(sql`'{}'::text[]`),
    subject: text('subject').notNull().default(''),
    body: text('body').notNull().default(''),
    /** WhatsApp only: the approved template and its ordered parameters. */
    templateName: text('template_name'),
    templateParameters: text('template_parameters').array(),
    /** Storage keys, resolved by the worker at send time. Never inline bytes. */
    attachmentStorageKeys: text('attachment_storage_keys').array().notNull().default(sql`'{}'::text[]`),

    state: deliveryState('state').notNull().default('not_started'),
    providerMessageId: text('provider_message_id'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: instant('next_attempt_at'),
    lastError: text('last_error').notNull().default(''),

    createdAt: createdAt(),
    createdBy: uuid('created_by').references(() => users.id),
    updatedAt: instant('updated_at')
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    uniqueIndex('message_outbox_idempotency_key').on(table.idempotencyKey),
    // The worker's claim query: what is due, oldest first.
    index('message_outbox_due_idx')
      .on(table.nextAttemptAt)
      .where(sql`${table.state} in ('not_started', 'sending', 'pending_delivery')`),
    index('message_outbox_job_idx')
      .on(table.jobId)
      .where(sql`${table.jobId} is not null`),
  ],
);
