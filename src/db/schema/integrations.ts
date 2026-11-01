import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { instant, primaryId } from './columns';
import { users } from './identity';
import { jobs } from './jobs';

/**
 * Customer email templates, the email outbox, WhatsApp webhook events, and the
 * geocoding cache. Migration 0042 (INT-EMAIL, INT-WA, INT-MAP). The rules that
 * make an impossible row impossible are in the migration itself — one default
 * per event and job type, a version never edited, a sent email never changed —
 * and the drizzle definitions below only describe the columns.
 */
export const emailTemplates = pgTable(
  'email_templates',
  {
    id: primaryId(),
    event: text('event').notNull(),
    jobType: text('job_type').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    active: boolean('active').notNull().default(false),
    isDefault: boolean('is_default').notNull().default(false),
    currentVersion: integer('current_version').notNull().default(1),
    systemKey: text('system_key'),
    createdAt: instant('created_at').notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'restrict' }),
    updatedAt: instant('updated_at').notNull().defaultNow(),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'restrict' }),
  },
  (table) => [
    uniqueIndex('email_templates_one_default')
      .on(table.event, table.jobType)
      .where(sql`${table.isDefault}`),
    uniqueIndex('email_templates_system_key')
      .on(table.systemKey)
      .where(sql`${table.systemKey} is not null`),
  ],
);

export const emailTemplateVersions = pgTable(
  'email_template_versions',
  {
    id: primaryId(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => emailTemplates.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    changeNote: text('change_note').notNull().default(''),
    createdAt: instant('created_at').notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'restrict' }),
  },
  (table) => [unique('email_template_versions_unique').on(table.templateId, table.version)],
);

export const emailMessages = pgTable(
  'email_messages',
  {
    id: primaryId(),
    idempotencyKey: text('idempotency_key').notNull(),
    event: text('event').notNull(),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'restrict' }),
    templateId: uuid('template_id').references(() => emailTemplates.id, { onDelete: 'restrict' }),
    templateVersionId: uuid('template_version_id').references(() => emailTemplateVersions.id, {
      onDelete: 'restrict',
    }),
    templateName: text('template_name').notNull().default(''),
    templateVersion: integer('template_version'),
    sender: text('sender').notNull().default(''),
    recipient: text('recipient').notNull().default(''),
    cc: jsonb('cc').$type<string[]>().notNull().default([]),
    subject: text('subject').notNull().default(''),
    body: text('body').notNull().default(''),
    attachmentStorageKey: text('attachment_storage_key'),
    attachmentFileName: text('attachment_file_name'),
    attachmentSha256: text('attachment_sha256'),
    state: text('state').notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: instant('next_attempt_at'),
    lastAttemptAt: instant('last_attempt_at'),
    sentAt: instant('sent_at'),
    providerRequestId: text('provider_request_id'),
    failureKind: text('failure_kind'),
    failureReason: text('failure_reason').notNull().default(''),
    retryOf: uuid('retry_of'),
    createdAt: instant('created_at').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'restrict' }),
    updatedAt: instant('updated_at').notNull(),
  },
  (table) => [
    unique('email_messages_idempotency_key_unique').on(table.idempotencyKey),
    uniqueIndex('email_messages_one_live_per_document')
      .on(table.jobId, table.event, table.attachmentStorageKey)
      .where(sql`${table.state} in ('queued', 'sending', 'sent')`),
    index('email_messages_due_idx')
      .on(table.nextAttemptAt)
      .where(sql`${table.state} in ('queued', 'sending')`),
    index('email_messages_job_idx').on(table.jobId, table.createdAt),
  ],
);

export const whatsappWebhookEvents = pgTable(
  'whatsapp_webhook_events',
  {
    id: text('id').primaryKey(),
    providerMessageId: text('provider_message_id').notNull(),
    status: text('status').notNull(),
    errorCode: text('error_code').notNull().default(''),
    errorTitle: text('error_title').notNull().default(''),
    occurredAt: instant('occurred_at'),
    receivedAt: instant('received_at').notNull(),
    matched: boolean('matched').notNull().default(false),
  },
  (table) => [index('whatsapp_webhook_events_message_idx').on(table.providerMessageId)],
);

export const geocodeCache = pgTable('geocode_cache', {
  queryKey: text('query_key').primaryKey(),
  provider: text('provider').notNull(),
  outcome: text('outcome').notNull(),
  result: jsonb('result').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: instant('created_at').notNull(),
  expiresAt: instant('expires_at').notNull(),
});

export const integrationUsage = pgTable(
  'integration_usage',
  {
    day: date('day', { mode: 'string' }).notNull(),
    service: text('service').notNull(),
    requests: integer('requests').notNull().default(0),
  },
  (table) => [primaryKey({ name: 'integration_usage_pk', columns: [table.day, table.service] })],
);

export const integrationState = pgTable('integration_state', {
  service: text('service').primaryKey(),
  fingerprint: text('fingerprint').notNull(),
  summary: text('summary').notNull().default(''),
  updatedAt: instant('updated_at').notNull(),
});
