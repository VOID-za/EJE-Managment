import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * PostgreSQL enums, mirrored from the domain's closed unions.
 *
 * Every enum below exists as a union in `src/domain/types/*`. They are declared
 * here rather than as text columns because the domain genuinely treats them as
 * closed sets — `jobStatusLabel` has an exhaustive switch over `JobStatus`, and
 * a row carrying a status the domain has never heard of would be a record no
 * screen can render.
 *
 * KEEPING THEM IN STEP: `schema.test.ts` asserts, for every enum here, that its
 * members equal the domain union exactly. Adding a member to the domain without
 * a migration therefore fails the test suite rather than failing in production.
 *
 * WHAT IS DELIBERATELY NOT AN ENUM: job types and machine types. Both docblocks
 * in the domain already say they become administered rows in Phase 2
 * (`job-types.ts`: "Phase 2 replaces the constant below with rows loaded from a
 * `job_types` table"), so they are reference TABLES with text keys, not enums.
 */

export const userRole = pgEnum('user_role', ['master', 'coordinator', 'technician']);

export const jobStatus = pgEnum('job_status', [
  'draft',
  'open',
  'in_progress',
  'awaiting_spares',
  'completion',
  'customer_signature',
  'review',
  'awaiting_delivery',
  // Historical only. No transition leads into it; kept so jobs that entered the
  // retired Master Review stage before it was removed stay readable.
  'submitted',
  'closed',
  'cancelled',
]);

export const jobPriority = pgEnum('job_priority', ['low', 'normal', 'high', 'urgent']);

export const cancellationReason = pgEnum('cancellation_reason', [
  'customer_resolved',
  'customer_cancelled',
  'duplicate',
  'no_longer_required',
  'customer_unavailable',
  'other',
]);

export const transferReason = pgEnum('transfer_reason', [
  'unable_to_attend',
  'sick_or_unavailable',
  'vehicle_problem',
  'scheduling_conflict',
  'requires_another_technician',
  'customer_requested',
  'other',
]);

export const labourRateType = pgEnum('labour_rate_type', ['normal', 'overtime', 'double']);

/**
 * How a job type treats the customer's order number. DECISION 2.
 *
 * Three values, not a boolean, because the business distinguishes three cases:
 * Parts cannot be handed over without one; Installation and Service are
 * expected to have one and may proceed past an explicit acknowledgement; a
 * breakdown call-out has none and never will at the time of the visit.
 */
export const orderNumberExpectation = pgEnum('order_number_expectation', [
  'required',
  'expected',
  'optional',
]);

export const attachmentKind = pgEnum('attachment_kind', ['photo', 'video', 'document']);

export const pricingSnapshotReason = pgEnum('pricing_snapshot_reason', [
  'customer_signature',
  'signature_refused',
  'submission',
]);

export const refusalResolution = pgEnum('refusal_resolution', ['resubmitted', 'issued_unsigned']);

export const checklistResponseType = pgEnum('checklist_response_type', [
  'pass_fail_na',
  'measurement',
  'text',
  'yes_no',
]);

export const checklistVersionStatus = pgEnum('checklist_version_status', [
  'draft',
  'current',
  'archived',
]);

export const passFailNa = pgEnum('pass_fail_na', ['pass', 'fail', 'na']);

export const machineApproval = pgEnum('machine_approval', ['approved', 'pending_approval']);

export const availabilityType = pgEnum('availability_type', [
  'appointment',
  'sick_leave',
  'annual_leave',
  'personal_leave',
  'training',
  'other',
]);

export const availabilityStatus = pgEnum('availability_status', ['active', 'cancelled']);

export const notificationType = pgEnum('notification_type', [
  'job_assigned',
  'job_transferred',
  'customer_change_request',
  'machine_approval_request',
  'document_approval_request',
  'job_submitted',
  'signature_refused',
  'chat_message',
]);

export const notificationChannel = pgEnum('notification_channel', ['in_app', 'whatsapp', 'email']);

export const technicalDocumentType = pgEnum('technical_document_type', [
  'machine_manual',
  'electrical_diagram',
  'service_manual',
  'safety_procedure',
  'work_procedure',
  'datasheet',
]);

export const libraryDocumentStatus = pgEnum('library_document_status', [
  'current',
  'archived',
  'pending_approval',
]);

/**
 * Where a message actually got to.
 *
 * `pending_delivery` is the honest answer to a provider's 202: it accepted the
 * message, and nobody has confirmed the customer received it. Only `delivered`
 * means the customer has it. See `src/domain/types/delivery.ts`, which exists
 * to stop a job closing on a send nothing confirmed.
 */
export const deliveryState = pgEnum('delivery_state', [
  'not_started',
  'sending',
  'pending_delivery',
  'delivered',
  'failed',
]);

export const outboxChannel = pgEnum('outbox_channel', ['email', 'whatsapp']);

/**
 * How a technician came to be a participant on a job. DECISION 5.
 *
 * Participation is what survives a reassignment, so the reason has to be
 * recorded at the moment it starts rather than inferred from the job's current
 * state — which is precisely the information a reassignment destroys.
 */
export const jobParticipationRole = pgEnum('job_participation_role', [
  'primary_technician',
  'additional_technician',
]);
