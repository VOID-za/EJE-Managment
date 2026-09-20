import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, instant, primaryId } from './columns';
import { refusalResolution } from './enums';
import { jobs } from './jobs';
import { users } from './identity';

/**
 * The customer's acceptance. WRITE-ONCE.
 *
 * One signature per job. If a refusal was corrected and the card went back, the
 * customer either signs (this row) or refuses again (another refusal row) —
 * there is never a second signature, because there was never a second
 * acceptance to record.
 *
 * `stroke_data` stays in the row rather than in file storage. It is a few
 * kilobytes of SVG path, it must never be separable from the acceptance it
 * belongs to, and putting it behind a storage key creates a way for a signed
 * job card to lose its signature.
 */
export const jobSignatures = pgTable(
  'job_signatures',
  {
    id: primaryId(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    customerName: text('customer_name').notNull(),
    customerSurname: text('customer_surname').notNull(),
    /** The drawn path. A real signature always begins with an SVG move command. */
    strokeData: text('stroke_data').notNull(),
    /**
     * What they put their name to, copied in full.
     *
     * Stored rather than looked up, because the wording differs by job type — a
     * parts collector acknowledges receipt of goods, not completed work — and
     * the declaration on the document must be the one they actually saw.
     */
    declaration: text('declaration').notNull(),
    signedAt: instant('signed_at').notNull(),
    capturedBy: uuid('captured_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('job_signatures_job_key').on(table.jobId),
    check('job_signatures_name_present', sql`btrim(${table.customerName}) <> ''`),
    check('job_signatures_surname_present', sql`btrim(${table.customerSurname}) <> ''`),
    check('job_signatures_stroke_present', sql`btrim(${table.strokeData}) <> ''`),
  ],
);

/**
 * The customer would not sign. APPEND-ONLY, oldest first.
 *
 * NOT A STATUS. The six-stage progress model is unchanged — Open, In Progress,
 * Completion, Customer Signature, Review, Closed — and a refusal is an
 * exception attached to Customer Signature, held at Review by a blocking
 * condition on the job rather than by a stage of its own.
 *
 * A job may have several. Attempt 1 is refused; the office corrects the card
 * and returns it; the customer signs, or refuses again as attempt 2. ATTEMPT 1
 * IS NEVER OVERWRITTEN — its reason, who recorded it and when are written once
 * and frozen. Only the resolution fields may be filled in, once, by the office.
 *
 * THE REASON LIVES HERE AND NOWHERE ELSE. It used to be copied into the audit
 * detail as well, which put one fact under two sets of read rules and let a
 * technician read another technician's refusal on the activity feed. One copy,
 * one rule: `canSeeSignatureRefusal`.
 */
export const signatureRefusals = pgTable(
  'signature_refusals',
  {
    id: primaryId(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    /** 1, 2, 3 … so the order is explicit rather than inferred from a timestamp. */
    attempt: integer('attempt').notNull(),

    /* ---- frozen at the moment of refusal ---- */
    reason: text('reason').notNull(),
    recordedBy: uuid('recorded_by')
      .notNull()
      .references(() => users.id),
    recordedAt: instant('recorded_at').notNull(),

    /* ---- written once, by the office, when it is dealt with ---- */
    resolvedBy: uuid('resolved_by').references(() => users.id),
    resolvedAt: instant('resolved_at'),
    /** `resubmitted` — corrected and returned; `issued_unsigned` — issued as it stands. */
    resolution: refusalResolution('resolution'),
    resolutionNote: text('resolution_note').notNull().default(''),

    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('signature_refusals_job_attempt_key').on(table.jobId, table.attempt),
    index('signature_refusals_job_idx').on(table.jobId, table.attempt),
    // The office's queue: refusals nobody has dealt with yet.
    index('signature_refusals_outstanding_idx')
      .on(table.recordedAt)
      .where(sql`${table.resolvedAt} is null`),
    /**
     * PRESENCE, and nothing more.
     *
     * A technician standing in a workshop writing "Customer unavailable" has
     * said what happened; a length rule cannot tell a terse answer from a
     * useless one. Empty and whitespace-only are refused — that is the whole
     * rule, and it matches `checkRefusalReason` exactly.
     */
    check('signature_refusals_reason_present', sql`btrim(${table.reason}) <> ''`),
    check('signature_refusals_attempt_positive', sql`${table.attempt} >= 1`),
    // Resolved means all three resolution fields, or none of them.
    check(
      'signature_refusals_resolution_complete',
      sql`(${table.resolvedAt} is null and ${table.resolution} is null and ${table.resolvedBy} is null)
          or (${table.resolvedAt} is not null and ${table.resolution} is not null and ${table.resolvedBy} is not null)`,
    ),
  ],
);
