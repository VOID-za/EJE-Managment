import { sql } from 'drizzle-orm';
import { index, inet, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, instant, primaryId } from './columns';
import { userRole } from './enums';
import { users } from './identity';

/**
 * The audit trail. APPEND-ONLY, for ever.
 *
 * WHY `job_id` IS NOT A FOREIGN KEY
 * ---------------------------------
 * DECISION 6 makes job deletion PERMANENT, and requires that the audit event
 * recording the deletion survives the job. A foreign key would make that
 * impossible: `on delete cascade` would take the evidence with the job, and
 * `on delete restrict` would refuse the deletion the decision requires.
 * `set null` would keep the row but lose which job it was about — which is the
 * one thing the event exists to say.
 *
 * So the job is referenced by VALUE, not by constraint: the id and the job
 * number are both recorded, and both outlive the row they describe. The same
 * applies to `entity_id` for every other kind of record.
 *
 * WHAT IS NOT IN HERE
 * -------------------
 * A customer's reason for refusing to sign. That lives on the refusal record
 * and nowhere else, under `canSeeSignatureRefusal`. Copying it here put one
 * fact under two sets of read rules and let a technician read another
 * technician's refusal on the activity feed. The trail records THAT a refusal
 * happened, on which job, by whom and when — which is what an audit trail is
 * for.
 *
 * Passwords, session tokens and message bodies are likewise never recorded.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: primaryId(),
    occurredAt: instant('occurred_at').notNull(),

    /** Null for an event the system raised with no human behind it. */
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    /**
     * The actor's role AT THE TIME.
     *
     * Captured rather than joined, because a technician later promoted to
     * Coordinator must not retroactively appear to have acted as one.
     */
    actorRole: userRole('actor_role'),
    /** Their name as it was, so the trail reads correctly after a rename. */
    actorName: text('actor_name').notNull().default(''),

    /** One of the `ActivityEventType` union members. */
    type: text('type').notNull(),
    summary: text('summary').notNull(),
    detail: text('detail').notNull().default(''),

    /* ---- what it was about, referenced by value ---- */
    /** Deliberately NOT a foreign key. See the docblock. */
    jobId: uuid('job_id'),
    /** Kept so a deleted job's events still name it in a human way. */
    jobNumber: text('job_number'),
    /** `customer` | `machine` | `user` | `document` | `checklist` | … */
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),

    /**
     * Structured extras, where an event genuinely has them.
     *
     * JSONB rather than a column per event type, because there are 71 event
     * types and most carry nothing beyond the summary. Used sparingly: the
     * readable `summary` and `detail` remain the record a person looks at.
     */
    metadata: jsonb('metadata'),

    /* ---- request context, for security events ---- */
    requestId: uuid('request_id'),
    sessionId: uuid('session_id'),
    ip: inet('ip'),

    createdAt: createdAt(),
  },
  (table) => [
    index('audit_events_occurred_at_idx').on(table.occurredAt),
    index('audit_events_job_idx')
      .on(table.jobId, table.occurredAt)
      .where(sql`${table.jobId} is not null`),
    index('audit_events_actor_idx').on(table.actorId, table.occurredAt),
    index('audit_events_type_idx').on(table.type, table.occurredAt),
    index('audit_events_entity_idx')
      .on(table.entityType, table.entityId)
      .where(sql`${table.entityId} is not null`),
  ],
);

/**
 * Where events go when they age out of the hot table.
 *
 * DECISION 7: job-bound events are kept for the life of the job record,
 * administrative events for seven years, security events for two — and nothing
 * is ever deleted in place, only moved.
 *
 * THE MOVE IS NOT AUTOMATED IN THIS PHASE. The table exists because the
 * retention policy is agreed and a later archival job needs somewhere to put
 * things; creating it now costs nothing and avoids a migration against a large
 * live table later.
 */
export const auditEventsArchive = pgTable(
  'audit_events_archive',
  {
    id: uuid('id').primaryKey(),
    occurredAt: instant('occurred_at').notNull(),
    actorId: uuid('actor_id'),
    actorRole: userRole('actor_role'),
    actorName: text('actor_name').notNull().default(''),
    type: text('type').notNull(),
    summary: text('summary').notNull(),
    detail: text('detail').notNull().default(''),
    jobId: uuid('job_id'),
    jobNumber: text('job_number'),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    metadata: jsonb('metadata'),
    requestId: uuid('request_id'),
    sessionId: uuid('session_id'),
    ip: inet('ip'),
    createdAt: instant('created_at').notNull(),
    /** When this row was moved out of the hot table, and by which run. */
    archivedAt: instant('archived_at')
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    index('audit_events_archive_occurred_at_idx').on(table.occurredAt),
    index('audit_events_archive_job_idx')
      .on(table.jobId)
      .where(sql`${table.jobId} is not null`),
  ],
);
