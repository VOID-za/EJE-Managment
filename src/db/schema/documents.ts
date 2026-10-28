import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bigintNumber, cents, createdAt, instant, primaryId, provenance } from './columns';
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
    /**
     * A job card EJE issued, or a demonstration one. October mandate §1.
     *
     * The six seeded job cards are demonstration data whose PDF is rendered on
     * first download; a simulated document is stamped on every page, so the
     * file itself says what it is and not only the screen it came from.
     */
    provenance: provenance(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('final_documents_job_key').on(table.jobId),
    uniqueIndex('final_documents_storage_key_key').on(table.storageKey),
    check('final_documents_page_count_positive', sql`${table.pageCount} >= 1`),
    check('final_documents_provenance_known', sql`${table.provenance} in ('genuine', 'simulated', 'unknown')`),
  ],
);

/**
 * THE COURIER'S DELIVERY NOTE, AS ISSUED. WRITE-ONCE. PARTS-03/04, migration 0038.
 *
 * Rendered and stored at the same moment as the priced job card it goes with
 * (`final_documents`), for a courier collection only, and never regenerated.
 * The courier signs ONCE — on the Delivery Note — and that one signature is the
 * job's signature: `signature_sha256` is the SHA-256 of its stroke data, which
 * the priced job card also prints, so the two documents can be tied to the same
 * signing act without either pretending to a second one.
 */
export const deliveryNoteDocuments = pgTable(
  'delivery_note_documents',
  {
    id: primaryId(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'restrict' }),
    fileName: text('file_name').notNull(),
    storageKey: text('storage_key').notNull(),
    pageCount: integer('page_count').notNull(),
    sizeBytes: integer('size_bytes').notNull().default(0),
    checksumSha256: text('checksum_sha256'),
    generatedAt: instant('generated_at').notNull(),
    generatedBy: uuid('generated_by').references(() => users.id),
    /** The priced job card this note accompanies: `final_documents.storage_key`, so named not to be counted twice by the backup scan. */
    jobCardDocumentKey: text('job_card_document_key').notNull(),
    signedByName: text('signed_by_name'),
    signedAt: instant('signed_at'),
    signatureSha256: text('signature_sha256'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('delivery_note_documents_job_key').on(table.jobId),
    uniqueIndex('delivery_note_documents_storage_key_key').on(table.storageKey),
    check(
      'delivery_note_documents_signature_whole',
      sql`(${table.signedAt} is null and ${table.signedByName} is null and ${table.signatureSha256} is null) or (${table.signedAt} is not null and ${table.signedByName} is not null and ${table.signatureSha256} is not null)`,
    ),
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
    /*
     * WHICH KIND of failure, so the office knows whether *Send again* can work.
     *
     * `failure_reason` is the provider's own sentence and belongs on a screen;
     * this is the part somebody can act on — a credential to correct, an
     * address to fix, a document too large, or simply "try again". Nullable
     * because a transport need not classify, and because every row written
     * before this column existed is legitimately unclassified. Deliberately
     * `text` rather than an enum: a new provider's new failure mode must not
     * need a migration to be recorded, and the domain's own union
     * (`DeliveryFailureKind`) is what readers narrow against.
     */
    failureKind: text('failure_kind'),
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
    // A kind explains a FAILURE. An accepted or delivered attempt has none.
    check(
      'delivery_attempts_kind_only_on_failure',
      sql`${table.failureKind} is null or ${table.state} = 'failed'`,
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

/**
 * WHEN THIS DATABASE BEGAN RECORDING PROVENANCE. October mandate §1.3.
 *
 * One row, written by migration 0018. Everything created before
 * `recorded_from` took the provenance column's original `genuine` default and
 * was therefore never recorded as anything; everything after it was written by
 * code that states the value.
 *
 * IT EXISTS BECAUSE `final_documents` IS WRITE-ONCE. The other five tables
 * carrying provenance had their pre-0015 rows relabelled `unknown` in place.
 * A job card cannot be — `refuse_mutation()` refuses UPDATE on it, and that
 * refusal is one of the protections CR-01 rests on — and the trigger's own
 * message says what to do instead: "correct it by adding a new record". This
 * is that record, and `documents:reconcile` reads it rather than trusting a
 * backfilled label.
 */
export const provenanceRecording = pgTable('provenance_recording', {
  /** Always `cutoff`. One row; the key exists so it stays one row. */
  id: text('id').primaryKey(),
  recordedFrom: instant('recorded_from').notNull(),
  note: text('note').notNull().default(''),
});

/**
 * A CORRECTION TO AN ISSUED JOB CARD. BD-02, IMMUT-9, AUD-3.
 *
 * APPEND-ONLY, with exactly one thing that may be filled in later: the
 * customer's acknowledgement. The shape `signature_refusals` already uses, and
 * for the same reason — what was raised is a historical fact, and what the
 * customer then said is a later one.
 *
 * `corrects_document_id` points at a `final_documents` row, which is
 * write-once. That is deliberate: a correction names an exact set of bytes the
 * customer holds, not "whatever this job card says now". RESTRICT, so the
 * document it corrects cannot be removed from under it.
 *
 * THE ADDENDUM HAS ITS OWN FILE. It is not a re-render of the job card: a
 * re-render would be a different document wearing the original's date, which
 * is the one thing a frozen job card exists to prevent.
 */
export const jobCorrections = pgTable(
  'job_corrections',
  {
    id: primaryId(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'restrict' }),
    /** 1 for the first correction to this job. Printed on the addendum. */
    sequence: integer('sequence').notNull(),
    /*
     * NAMED IN THE EXTRAS BELOW, NOT INLINE, AND THE REASON IS A SILENT
     * TRUNCATION. Drizzle's generated name for this key —
     * `job_corrections_corrects_document_key_final_documents_storage_key_fk`
     * — is 68 characters, and PostgreSQL cuts an identifier at 63 with a
     * NOTICE nobody reads. The constraint then exists under a name that does
     * not appear anywhere in this repository, so a later migration that drops
     * or renames it by the name written here would fail against a database
     * that has it.
     */
    correctsDocumentKey: text('corrects_document_key').notNull(),
    reason: text('reason').notNull(),
    narrative: text('narrative').notNull(),
    /** Which parts of the job card are affected. At least one; see the CHECK. */
    areas: text('areas').array().notNull(),
    raisedBy: uuid('raised_by').references(() => users.id),
    raisedAt: instant('raised_at').notNull(),
    /** `not_required`, `required` or `recorded`. See `AcknowledgementState`. */
    acknowledgement: text('acknowledgement').notNull().default('not_required'),
    acknowledgedBy: text('acknowledged_by'),
    acknowledgementMethod: text('acknowledgement_method'),
    acknowledgementRecordedBy: uuid('acknowledgement_recorded_by').references(() => users.id),
    acknowledgementRecordedAt: instant('acknowledgement_recorded_at'),
    acknowledgementNote: text('acknowledgement_note').notNull().default(''),

    documentFileName: text('document_file_name').notNull(),
    documentStorageKey: text('document_storage_key').notNull(),
    documentSizeBytes: bigintNumber('document_size_bytes').notNull(),
    documentChecksumSha256: text('document_checksum_sha256'),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: 'job_corrections_document_fk',
      columns: [table.correctsDocumentKey],
      foreignColumns: [finalDocuments.storageKey],
    }).onDelete('restrict'),
    uniqueIndex('job_corrections_job_sequence_key').on(table.jobId, table.sequence),
    uniqueIndex('job_corrections_storage_key_key').on(table.documentStorageKey),
    index('job_corrections_job_idx').on(table.jobId, table.raisedAt),
    check('job_corrections_sequence_positive', sql`${table.sequence} >= 1`),
    check('job_corrections_reason_present', sql`length(btrim(${table.reason})) > 0`),
    check('job_corrections_narrative_present', sql`length(btrim(${table.narrative})) > 0`),
    /*
     * A correction that names no part of the job card is not a correction.
     *
     * `cardinality`, NOT `array_length(areas, 1)`: on an empty array the
     * latter returns NULL, `NULL >= 1` is NULL, and a CHECK treats NULL as
     * satisfied — so the first version of this accepted exactly the row it was
     * written to refuse. Found by the db test, which is why it is there.
     */
    check('job_corrections_areas_present', sql`cardinality(${table.areas}) >= 1`),
    check('job_corrections_size_positive', sql`${table.documentSizeBytes} > 0`),
    check(
      'job_corrections_acknowledgement_known',
      sql`${table.acknowledgement} in ('not_required', 'required', 'recorded')`,
    ),
    /*
     * RECORDED MEANS RECORDED. The state and the detail cannot disagree: a row
     * saying the customer acknowledged it must say who and how, and a row that
     * does not say `recorded` must carry neither.
     */
    check(
      'job_corrections_acknowledgement_consistent',
      sql`(${table.acknowledgement} = 'recorded') =
          (${table.acknowledgedBy} is not null and ${table.acknowledgementRecordedAt} is not null)`,
    ),
  ],
);

/**
 * A MASTER AUTHORISING THE SENDING OF A JOB CARD THE CUSTOMER DID NOT SIGN.
 * BD-06, DELIV-7, AUD-4.
 *
 * APPEND-ONLY. One row per job — the authorisation is a decision about this
 * job's unsigned document, and a retry of a failed send does not need a second
 * one. What happened to each attempt lives on `job.delivery` and in the audit
 * trail, which is where every other delivery attempt is recorded.
 *
 * WHY A TABLE RATHER THAN A FLAG ON THE JOB. Because the question somebody
 * will ask in a year is "who decided to send this, and why" — and a boolean
 * answers neither. `document_key` pins the exact bytes that were authorised,
 * so an authorisation cannot be read as covering some later document.
 */
export const unsignedDeliveryAuthorisations = pgTable(
  'unsigned_delivery_authorisations',
  {
    id: primaryId(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'restrict' }),
    /**
     * The bytes this authorises. A foreign key to the issued document, named
     * in the extras below for the same reason as `job_corrections`: the
     * generated name is 76 characters and PostgreSQL would cut it at 63.
     */
    documentKey: text('document_key').notNull(),
    /** Where it may be sent. Taken from the document, never from a browser. */
    recipient: text('recipient').notNull(),
    /** Why the office is sending a document the customer declined to sign. */
    reason: text('reason').notNull(),
    authorisedBy: uuid('authorised_by').references(() => users.id),
    authorisedAt: instant('authorised_at').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: 'unsigned_delivery_authorisations_document_fk',
      columns: [table.documentKey],
      foreignColumns: [finalDocuments.storageKey],
    }).onDelete('restrict'),
    uniqueIndex('unsigned_delivery_authorisations_job_key').on(table.jobId),
    check(
      'unsigned_delivery_authorisations_reason_present',
      sql`length(btrim(${table.reason})) > 0`,
    ),
    check(
      'unsigned_delivery_authorisations_recipient_present',
      sql`length(btrim(${table.recipient})) > 0`,
    ),
  ],
);
