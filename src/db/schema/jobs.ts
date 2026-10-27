import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { cents, createdAt, instant, primaryId, rowVersion, updatedAt } from './columns';
import {
  attachmentKind,
  mediaVisibility,
  cancellationReason,
  jobParticipationRole,
  jobPriority,
  jobStatus,
  labourRateType,
  transferReason,
} from './enums';
import { contacts, customers, sites } from './customers';
import { machines } from './machines';
import { users } from './identity';
import { jobTypes } from './settings';

/**
 * The job.
 *
 * The demo holds one object with eleven embedded arrays. Here the root carries
 * the job's own facts and the children are tables, because the arrays are
 * genuinely separate things: a labour line has its own author, its own capture
 * timestamp and its own lifecycle. The DOMAIN TYPE DOES NOT CHANGE — the
 * repository reassembles a `Job` from the root plus its children.
 *
 * NO SOFT DELETE. DECISION 6 makes job deletion permanent, and permitted only
 * for an open, unaccepted job. There is therefore no `deleted_at` here and no
 * "deleted job" to leak into a list. The audit event recording the deletion
 * survives it — see `audit.ts`, whose `job_id` is deliberately NOT a foreign
 * key for exactly this reason.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: primaryId(),

    /**
     * The human identifier, `EJE-####`.
     *
     * Allocated from a PostgreSQL sequence, never from `max(job_number) + 1`
     * and never from the client. See `0001_job_numbering.sql`.
     */
    jobNumber: text('job_number').notNull(),
    /** The raw sequence value behind `job_number`, kept so ordering is numeric. */
    jobNumberSeq: integer('job_number_seq').notNull(),

    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'restrict' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'restrict' }),
    /** Null for a Parts collection, which is goods rather than work on a machine. */
    machineId: uuid('machine_id').references(() => machines.id, { onDelete: 'restrict' }),

    jobTypeCode: text('job_type_code')
      .notNull()
      .references(() => jobTypes.code),
    /*
     * HOW URGENT, OR NOT YET GRADED. Create New Job §3B / §4.
     *
     * Nullable since 0027. A breakdown is called in before anybody has graded
     * it and a test-and-repair unit arrives on the counter without one, so the
     * column has to be able to say "nobody has said" — and the alternative,
     * defaulting to a grade, would put an urgency on the job list and the
     * customer's job card that no person chose. Which job types must carry one
     * is `JobTypeDefinition.requiresPriority`, enforced in the operation.
     */
    priority: jobPriority('priority'),
    status: jobStatus('status').notNull(),

    /**
     * DECISION 1: a job may be raised without a date.
     *
     * The rule is that it must have one BEFORE ASSIGNMENT, and a Service job
     * must have both. That is a transition rule, so it lives in the application
     * layer where `checkSchedule` already is — a NOT NULL here would make the
     * legitimate "raise it now, book it later" case impossible.
     *
     * What the database does enforce is the part that is never legitimate: an
     * end without a start, and an end before the start.
     */
    scheduledDate: date('scheduled_date'),
    scheduledEndDate: date('scheduled_end_date'),

    orderNumber: text('order_number').notNull().default(''),
    /*
     * THE UNIT BOOKED IN FOR TEST AND REPAIR, AND THE CUSTOMER'S QUOTE NUMBER.
     * Test & Repair §4.
     *
     * Four columns, all optional, all defaulted so every existing job reads as
     * "nobody filled this in" rather than as null-vs-empty ambiguity. The
     * quantity is the one that can be genuinely absent, so it stays nullable —
     * a zero would claim somebody counted nothing.
     *
     * DISTINCT FROM `job_parts`, which is what was CONSUMED in the repair and
     * is priced. This is what arrived on the counter.
     */
    repairPartNumber: text('repair_part_number').notNull().default(''),
    repairDescription: text('repair_description').notNull().default(''),
    repairQuantity: integer('repair_quantity'),
    quoteNumber: text('quote_number').notNull().default(''),
    /** When the unit arrived on the counter. Test & Repair; optional. 0031. */
    dateReceived: date('date_received'),
    /**
     * DECISION 2: an Installation or Service job may proceed without an order
     * number only through an explicit acknowledgement, which is recorded.
     *
     * Null means nobody has had to acknowledge anything — either the number is
     * present, or the type does not expect one.
     */
    orderNumberWaivedBy: uuid('order_number_waived_by').references(() => users.id),
    orderNumberWaivedAt: instant('order_number_waived_at'),
    orderNumberWaiverNote: text('order_number_waiver_note').notNull().default(''),

    referenceNumber: text('reference_number').notNull().default(''),
    faultDescription: text('fault_description').notNull().default(''),

    primaryTechnicianId: uuid('primary_technician_id').references(() => users.id),

    calloutApplied: boolean('callout_applied').notNull().default(false),
    /** BENCH-1. Whether the test bench fee applies. Frozen once signed (0035). */
    testBenchApplied: boolean('test_bench_applied').notNull().default(false),

    /**
     * DECISION 3 / the Parts workflow.
     *
     * Courier collection changes the DOCUMENT's content, not its identity: a
     * Test & Repair stays a Job Card and has its pricing suppressed on the
     * courier's copy. The waybill is the only thread between EJE's document and
     * the consignment, so the CHECK below makes a courier collection without
     * one impossible to store at all — the same rule `checkCollectionDetails`
     * enforces in the readiness gate.
     */
    courierCollection: boolean('courier_collection').notNull().default(false),
    waybillNumber: text('waybill_number').notNull().default(''),
    /** The customer's own delivery note reference, where they work by one. */
    deliveryNote: text('delivery_note').notNull().default(''),

    /*
     * THE SPARES REQUEST. SPARE-2.
     *
     * `awaiting_spares_reason` keeps its name and its data: it always held the
     * DESCRIPTION of what was needed, and renaming a populated column buys
     * nothing a comment cannot. The three beside it are what it never had.
     *
     * `awaiting_spares_requested_at` is what makes this a request rather than a
     * note: without it nobody can say how long a job has been waiting, which is
     * the first thing the office asks.
     */
    awaitingSparesReason: text('awaiting_spares_reason').notNull().default(''),
    awaitingSparesNotes: text('awaiting_spares_notes').notNull().default(''),
    /*
     * One of the job's OWN photographs, not a second upload path.
     *
     * A technician photographs the part or its nameplate as a job photo anyway;
     * pointing at that is the whole feature. `set null` rather than `cascade`:
     * removing the photograph must not delete the spares request that referred
     * to it.
     */
    awaitingSparesPhotoId: uuid('awaiting_spares_photo_id'),
    awaitingSparesRequestedAt: instant('awaiting_spares_requested_at'),

    /* ---- completion report: one-to-one, always present, so inline ---- */
    reportFaultFindings: text('report_fault_findings').notNull().default(''),
    reportDiagnosis: text('report_diagnosis').notNull().default(''),
    reportWorkPerformed: text('report_work_performed').notNull().default(''),
    reportRecommendations: text('report_recommendations').notNull().default(''),
    reportGeneralNotes: text('report_general_notes').notNull().default(''),

    /* ---- discount: money off the whole job, and on whose authority. COST-5 ---- */
    /**
     * Inline rather than its own table because there is at most ONE.
     *
     * A discount is a single commercial decision about the job, not a line of
     * work — see `JobDiscount`. The four columns are all-or-nothing, which the
     * CHECK below enforces: a reason with no amount, or an amount nobody
     * authorised, is a discount nobody can defend when the invoice is queried.
     */
    discountCents: cents('discount_cents'),
    discountReason: text('discount_reason').notNull().default(''),
    discountAuthorisedBy: uuid('discount_authorised_by').references(() => users.id),
    discountAuthorisedAt: instant('discount_authorised_at'),

    /* ---- cancellation: a legitimate job that will not happen ---- */
    cancellationReason: cancellationReason('cancellation_reason'),
    cancellationDescription: text('cancellation_description').notNull().default(''),
    cancelledBy: uuid('cancelled_by').references(() => users.id),
    cancelledAt: instant('cancelled_at'),

    /* ---- the office lifecycle after submission (issue #73). 0032 ---- */
    /** Who handled the submitted job card, moving it to Awaiting PO. Set once. */
    officeHandledBy: uuid('office_handled_by').references(() => users.id),
    officeHandledAt: instant('office_handled_at'),
    /** The invoice number the office recorded from Sage. Set once, never rewritten. */
    invoiceNumber: text('invoice_number'),
    invoicedBy: uuid('invoiced_by').references(() => users.id),
    invoicedAt: instant('invoiced_at'),

    createdAt: createdAt(),
    createdBy: uuid('created_by').references(() => users.id),
    acceptedAt: instant('accepted_at'),
    completedAt: instant('completed_at'),
    /** When the job card was issued and the customer's copy went out. */
    submittedAt: instant('submitted_at'),
    closedAt: instant('closed_at'),
    updatedAt: updatedAt(),
    version: rowVersion(),
  },
  (table) => [
    uniqueIndex('jobs_job_number_key').on(table.jobNumber),
    uniqueIndex('jobs_job_number_seq_key').on(table.jobNumberSeq),

    index('jobs_status_idx').on(table.status),
    index('jobs_primary_technician_idx').on(table.primaryTechnicianId, table.status),
    index('jobs_customer_idx').on(table.customerId),
    index('jobs_site_idx').on(table.siteId),
    index('jobs_machine_idx').on(table.machineId),
    index('jobs_job_type_idx').on(table.jobTypeCode),
    index('jobs_created_at_idx').on(table.createdAt),
    index('jobs_updated_at_idx').on(table.updatedAt),
    // The calendar asks for a window; cancelled work is not on it.
    index('jobs_scheduled_idx')
      .on(table.scheduledDate, table.scheduledEndDate)
      .where(sql`${table.status} <> 'cancelled'`),
    // The closed-job archive is searched from the recent end.
    index('jobs_closed_at_idx')
      .on(table.closedAt)
      .where(sql`${table.status} = 'closed'`),
    // The office's unassigned pool, which is also what a technician accepts from.
    index('jobs_open_pool_idx')
      .on(table.createdAt)
      .where(sql`${table.status} = 'open' and ${table.primaryTechnicianId} is null`),

    /*
     * A QUANTITY THAT EXISTS IS A REAL ONE. Test & Repair §4.
     *
     * Null is allowed and means nobody counted. Zero is not: it claims
     * somebody counted nothing, which is not goods on a counter. Negatives are
     * not either, for the obvious reason. `job_parts_quantity_positive` says
     * the same thing about the parts CONSUMED, and this is the same rule for
     * the unit that came IN.
     */
    check(
      'jobs_repair_quantity_positive',
      sql`${table.repairQuantity} is null or ${table.repairQuantity} > 0`,
    ),
    check(
      'jobs_schedule_end_needs_start',
      sql`${table.scheduledEndDate} is null or ${table.scheduledDate} is not null`,
    ),
    check(
      'jobs_schedule_end_not_before_start',
      sql`${table.scheduledEndDate} is null or ${table.scheduledEndDate} >= ${table.scheduledDate}`,
    ),
    check(
      'jobs_courier_needs_waybill',
      sql`not ${table.courierCollection} or btrim(${table.waybillNumber}) <> ''`,
    ),
    check(
      'jobs_cancelled_has_reason',
      sql`${table.status} <> 'cancelled' or ${table.cancellationReason} is not null`,
    ),
    /*
     * A DISCOUNT IS ALL FOUR COLUMNS OR NONE OF THEM. COST-5.
     *
     * Written as an equivalence rather than an implication so it refuses BOTH
     * halves of the mistake: an amount with nobody behind it, and an
     * authorisation with no amount. The reason is checked for being non-blank
     * rather than non-null, because the column is `not null default ''` — and
     * `btrim(…) <> ''` is the only form that refuses a reason of spaces.
     */
    check(
      'jobs_discount_is_whole_or_absent',
      sql`(${table.discountCents} is not null) = (${table.discountAuthorisedBy} is not null)
          and (${table.discountCents} is not null) = (${table.discountAuthorisedAt} is not null)
          and (${table.discountCents} is null or ${table.discountReason} ~ '[^[:space:]]')
          and (${table.discountCents} is not null
               or ${table.discountReason} !~ '[^[:space:]]')`,
    ),
    // Money off, not money on: a negative discount would be a charge wearing
    // the wrong name, and zero is not a discount at all.
    check(
      'jobs_discount_is_positive',
      sql`${table.discountCents} is null or ${table.discountCents} > 0`,
    ),
    /*
     * THE OFFICE LIFECYCLE, held to its own record. Issue #73. 0032.
     *
     * Written against `status::text` rather than the enum literals: the values
     * are added by the same migration, and PostgreSQL refuses to USE an enum
     * value in the transaction that adds it.
     */
    check(
      'jobs_office_handling_is_whole_or_absent',
      sql`(${table.officeHandledBy} is null) = (${table.officeHandledAt} is null)`,
    ),
    check(
      'jobs_invoice_is_whole_or_absent',
      sql`(${table.invoiceNumber} is null) = (${table.invoicedAt} is null)
          and (${table.invoiceNumber} is null) = (${table.invoicedBy} is null)
          and (${table.invoiceNumber} is null or ${table.invoiceNumber} ~ '[^[:space:]]')`,
    ),
    check(
      'jobs_awaiting_po_was_handled',
      sql`${table.status}::text not in ('awaiting_po', 'invoiced') or ${table.officeHandledAt} is not null`,
    ),
    check(
      'jobs_invoiced_has_invoice_number',
      sql`${table.status}::text <> 'invoiced' or ${table.invoiceNumber} is not null`,
    ),
  ],
);

/**
 * Additional technicians currently on the job.
 *
 * Current state only. Who was EVER on it is `job_participants`, which is what
 * the visibility rule reads — see DECISION 5.
 */
export const jobTechnicians = pgTable(
  'job_technicians',
  {
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    addedAt: createdAt(),
    addedBy: uuid('added_by').references(() => users.id),
  },
  (table) => [
    uniqueIndex('job_technicians_pkey').on(table.jobId, table.userId),
    index('job_technicians_user_idx').on(table.userId),
  ],
);

/**
 * Who has ever been on this job. APPEND-ONLY. DECISION 5.
 *
 * This is the table the technician visibility rule depends on, and the reason
 * it has to exist: the current assignee is destroyed by a reassignment, so a
 * technician who captured half a job on Tuesday would lose access to their own
 * work on Wednesday if visibility were derived from `jobs.primary_technician_id`.
 *
 * A row is written when participation STARTS and closed by setting `until` when
 * it ends. Rows are never deleted and never rewritten.
 */
export const jobParticipants = pgTable(
  'job_participants',
  {
    id: primaryId(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    role: jobParticipationRole('role').notNull(),
    since: instant('since').notNull(),
    /** Null while the participation is current. */
    until: instant('until'),
    /** Why it ended: a transfer, a removal. Free text, written once. */
    endedReason: text('ended_reason'),
    createdAt: createdAt(),
  },
  (table) => [
    // "Which jobs may this technician see?" — the visibility query's entry point.
    index('job_participants_user_idx').on(table.userId),
    index('job_participants_job_idx').on(table.jobId),
    // One open participation per person per role per job.
    uniqueIndex('job_participants_one_open')
      .on(table.jobId, table.userId, table.role)
      .where(sql`${table.until} is null`),
  ],
);

/**
 * A handover, recorded. APPEND-ONLY.
 *
 * The reason is mandatory and "other" requires a description — that rule is
 * `assertTransferReason` in the application layer, and the CHECK here makes the
 * state unstorable rather than merely unreachable.
 */
export const jobTransfers = pgTable(
  'job_transfers',
  {
    id: primaryId(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    fromUserId: uuid('from_user_id').references(() => users.id),
    /** Null when the job went back to the open pool rather than to a person. */
    toUserId: uuid('to_user_id').references(() => users.id),
    reason: transferReason('reason').notNull(),
    description: text('description').notNull().default(''),
    transferredBy: uuid('transferred_by')
      .notNull()
      .references(() => users.id),
    transferredAt: instant('transferred_at').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('job_transfers_job_idx').on(table.jobId, table.transferredAt),
    check(
      'job_transfers_other_needs_description',
      sql`${table.reason} <> 'other' or btrim(${table.description}) <> ''`,
    ),
  ],
);

/**
 * Captured labour.
 *
 * `technician_id` is WHOSE WORK IT IS; `captured_by` is WHO TYPED IT IN. Both,
 * always, because a Coordinator writing up what a technician telephoned in must
 * produce a job card crediting the technician and an audit trail naming the
 * Coordinator. `captureAttribution` in the application layer writes both.
 */
export const jobLabour = pgTable(
  'job_labour',
  {
    id: primaryId(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    technicianId: uuid('technician_id').references(() => users.id),
    capturedBy: uuid('captured_by').references(() => users.id),
    workDate: date('work_date').notNull(),
    rateType: labourRateType('rate_type').notNull(),
    hours: numeric('hours', { precision: 6, scale: 2 }).notNull(),
    description: text('description').notNull().default(''),
    capturedAt: instant('captured_at').notNull(),
    updatedAt: updatedAt(),
    version: rowVersion(),
  },
  (table) => [
    index('job_labour_job_idx').on(table.jobId),
    check('job_labour_hours_positive', sql`${table.hours} > 0`),
  ],
);

export const jobTravel = pgTable(
  'job_travel',
  {
    id: primaryId(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    technicianId: uuid('technician_id').references(() => users.id),
    capturedBy: uuid('captured_by').references(() => users.id),
    travelDate: date('travel_date').notNull(),
    kilometres: numeric('kilometres', { precision: 8, scale: 1 }).notNull(),
    description: text('description').notNull().default(''),
    capturedAt: instant('captured_at').notNull(),
    updatedAt: updatedAt(),
    version: rowVersion(),
  },
  (table) => [
    index('job_travel_job_idx').on(table.jobId),
    check('job_travel_kilometres_positive', sql`${table.kilometres} > 0`),
  ],
);

/**
 * Parts on the job.
 *
 * The prices stay HERE whatever the document shows. A courier's copy withholds
 * them; the job keeps them for EJE costing. Suppression is a property of the
 * document model, never of the stored data.
 */
export const jobParts = pgTable(
  'job_parts',
  {
    id: primaryId(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    partNumber: text('part_number').notNull(),
    description: text('description').notNull().default(''),
    quantity: integer('quantity').notNull(),
    unitPriceCents: cents('unit_price_cents').notNull(),
    capturedAt: instant('captured_at').notNull(),
    capturedBy: uuid('captured_by').references(() => users.id),
    updatedAt: updatedAt(),
    version: rowVersion(),
  },
  (table) => [
    index('job_parts_job_idx').on(table.jobId),
    index('job_parts_part_number_idx').on(sql`lower(${table.partNumber})`),
    check('job_parts_quantity_positive', sql`${table.quantity} > 0`),
    check('job_parts_unit_price_non_negative', sql`${table.unitPriceCents} >= 0`),
  ],
);

/**
 * Charges that are neither labour, nor travel, nor a part. COST-5.
 *
 * Its own table, like parts, because there can be many and each is its own line
 * on the customer's document. No quantity and no unit price: see
 * `AdditionalChargeEntry` for why inventing a quantity of one would put two
 * numbers on a document that can disagree.
 */
export const jobAdditionalCharges = pgTable(
  'job_additional_charges',
  {
    id: primaryId(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    description: text('description').notNull(),
    amountCents: cents('amount_cents').notNull(),
    capturedAt: instant('captured_at').notNull(),
    capturedBy: uuid('captured_by').references(() => users.id),
    updatedAt: updatedAt(),
    version: rowVersion(),
  },
  (table) => [
    index('job_additional_charges_job_idx').on(table.jobId),
    /*
     * A charge has to say what it is for. "Additional charge: R450" on a
     * customer's document with nothing beside it is a query, not a line.
     *
     * `~ '[^[:space:]]'` AND NOT `btrim(...) <> ''`, and the difference is not
     * pedantic: `btrim` with no second argument trims SPACES ONLY, so a
     * description of a single tab passes it. The db test caught exactly that.
     * This asks the question that was meant — is there one character here that
     * is not whitespace — and it is the form the rest of this schema should
     * move to.
     */
    check('job_additional_charges_has_description', sql`${table.description} ~ '[^[:space:]]'`),
    // Positive: money off the job is a discount, which is a different thing
    // with a different authority behind it.
    check('job_additional_charges_amount_positive', sql`${table.amountCents} > 0`),
  ],
);

/** Notes on the job. `internal` decides whether one reaches the customer's document. */
export const jobNotes = pgTable(
  'job_notes',
  {
    id: primaryId(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    authorId: uuid('author_id').references(() => users.id),
    internal: boolean('internal').notNull().default(false),
    createdAt: createdAt(),
  },
  (table) => [index('job_notes_job_idx').on(table.jobId, table.createdAt)],
);

/**
 * Photos and videos attached to the job.
 *
 * Removal is a soft mark: the bytes are retained because a photo is evidence of
 * what a machine looked like, and a technician deleting one by accident must
 * not destroy it. The FILE itself lives behind `StorageService` — this table
 * holds the key and the metadata, never the bytes.
 */
export const jobMedia = pgTable(
  'job_media',
  {
    id: primaryId(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    kind: attachmentKind('kind').notNull(),
    /*
     * WHO IT IS FOR. MEDIA-1.
     *
     * Defaults to `customer_facing`, which is what every existing row already
     * IS: the customer document has printed every photograph's caption since it
     * was written, so recording existing media as anything else would be
     * inventing a reclassification of records nobody reviewed. New media
     * defaults the same way and the technician marks the exceptions — most
     * photographs on a job are evidence of the work, not notes to the workshop.
     */
    visibility: mediaVisibility('visibility').notNull().default('customer_facing'),
    fileName: text('file_name').notNull(),
    caption: text('caption').notNull().default(''),
    storageKey: text('storage_key').notNull(),
    contentType: text('content_type').notNull().default(''),
    sizeBytes: cents('size_bytes').notNull().default(0),
    checksumSha256: text('checksum_sha256'),
    uploadedAt: instant('uploaded_at').notNull(),
    uploadedBy: uuid('uploaded_by').references(() => users.id),
    removedAt: instant('removed_at'),
    removedBy: uuid('removed_by').references(() => users.id),
  },
  (table) => [
    index('job_media_job_idx')
      .on(table.jobId)
      .where(sql`${table.removedAt} is null`),
    uniqueIndex('job_media_storage_key_key').on(table.storageKey),
  ],
);
