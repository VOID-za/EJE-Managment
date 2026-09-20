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
    priority: jobPriority('priority').notNull(),
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

    awaitingSparesReason: text('awaiting_spares_reason').notNull().default(''),

    /* ---- completion report: one-to-one, always present, so inline ---- */
    reportFaultFindings: text('report_fault_findings').notNull().default(''),
    reportDiagnosis: text('report_diagnosis').notNull().default(''),
    reportWorkPerformed: text('report_work_performed').notNull().default(''),
    reportRecommendations: text('report_recommendations').notNull().default(''),
    reportGeneralNotes: text('report_general_notes').notNull().default(''),

    /* ---- cancellation: a legitimate job that will not happen ---- */
    cancellationReason: cancellationReason('cancellation_reason'),
    cancellationDescription: text('cancellation_description').notNull().default(''),
    cancelledBy: uuid('cancelled_by').references(() => users.id),
    cancelledAt: instant('cancelled_at'),

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
