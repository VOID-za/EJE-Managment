import { and, asc, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import type {
  CustomerEmail,
  CustomerEmailState,
  EmailEvent,
  EmailTemplate,
  EmailTemplateVersion,
  EmailTemplateWithVersion,
  IsoDateTime,
  JobId,
  JobTypeCode,
} from '@/domain';
import type {
  CustomerEmailRepository,
  EmailTemplateRepository,
  GeocodeCacheEntry,
  IntegrationRepository,
  WhatsAppWebhookEvent,
} from '../repositories';
import * as schema from '@/db/schema';
import type { DatabaseExecutor } from '@/db/client';

/**
 * Templates, the customer email outbox and the integrations' bookkeeping, on
 * PostgreSQL. Migration 0042. The rules that make an impossible row impossible
 * (one default, versions never edited, a sent email never changed) are
 * enforced by the database; these classes only read and write.
 */

type TemplateRow = typeof schema.emailTemplates.$inferSelect;
type VersionRow = typeof schema.emailTemplateVersions.$inferSelect;
type EmailRow = typeof schema.emailMessages.$inferSelect;

const toTemplate = (row: TemplateRow): EmailTemplate => ({
  id: row.id,
  event: row.event as EmailEvent,
  jobType: row.jobType as JobTypeCode,
  name: row.name,
  description: row.description,
  active: row.active,
  isDefault: row.isDefault,
  currentVersion: row.currentVersion,
  systemKey: row.systemKey,
  createdAt: row.createdAt as IsoDateTime,
  createdBy: row.createdBy,
  updatedAt: row.updatedAt as IsoDateTime,
  updatedBy: row.updatedBy,
});

const toVersion = (row: VersionRow): EmailTemplateVersion => ({
  id: row.id,
  templateId: row.templateId,
  version: row.version,
  subject: row.subject,
  body: row.body,
  changeNote: row.changeNote,
  createdAt: row.createdAt as IsoDateTime,
  createdBy: row.createdBy,
});

/** The Postgres error code for a unique violation. */
const UNIQUE_VIOLATION = '23505';
const isUniqueViolation = (cause: unknown): boolean => {
  const code = (cause as { code?: unknown; cause?: { code?: unknown } } | null)?.code ??
    (cause as { cause?: { code?: unknown } } | null)?.cause?.code;
  return code === UNIQUE_VIOLATION;
};

export class PostgresEmailTemplateRepository implements EmailTemplateRepository {
  constructor(private readonly db: DatabaseExecutor) {}

  private async withCurrent(rows: readonly TemplateRow[]): Promise<EmailTemplateWithVersion[]> {
    if (rows.length === 0) return [];
    const versions = await this.db
      .select()
      .from(schema.emailTemplateVersions)
      .where(inArray(schema.emailTemplateVersions.templateId, rows.map((row) => row.id)));
    return rows.flatMap((row) => {
      const current = versions.find((version) => version.templateId === row.id && version.version === row.currentVersion);
      return current === undefined ? [] : [{ ...toTemplate(row), current: toVersion(current) }];
    });
  }

  async list(): Promise<readonly EmailTemplateWithVersion[]> {
    const rows = await this.db
      .select()
      .from(schema.emailTemplates)
      .orderBy(asc(schema.emailTemplates.event), asc(schema.emailTemplates.jobType), asc(schema.emailTemplates.name));
    return this.withCurrent(rows);
  }

  async findById(id: string): Promise<EmailTemplateWithVersion | null> {
    const rows = await this.db.select().from(schema.emailTemplates).where(eq(schema.emailTemplates.id, id)).limit(1);
    return (await this.withCurrent(rows))[0] ?? null;
  }

  async findDefault(event: EmailEvent, jobType: JobTypeCode): Promise<EmailTemplateWithVersion | null> {
    const rows = await this.db
      .select()
      .from(schema.emailTemplates)
      .where(
        and(
          eq(schema.emailTemplates.event, event),
          eq(schema.emailTemplates.jobType, jobType),
          eq(schema.emailTemplates.isDefault, true),
          eq(schema.emailTemplates.active, true),
        ),
      )
      .limit(1);
    return (await this.withCurrent(rows))[0] ?? null;
  }

  async versions(templateId: string): Promise<readonly EmailTemplateVersion[]> {
    const rows = await this.db
      .select()
      .from(schema.emailTemplateVersions)
      .where(eq(schema.emailTemplateVersions.templateId, templateId))
      .orderBy(desc(schema.emailTemplateVersions.version));
    return rows.map(toVersion);
  }

  async findVersion(templateId: string, version: number): Promise<EmailTemplateVersion | null> {
    const rows = await this.db
      .select()
      .from(schema.emailTemplateVersions)
      .where(and(eq(schema.emailTemplateVersions.templateId, templateId), eq(schema.emailTemplateVersions.version, version)))
      .limit(1);
    return rows[0] === undefined ? null : toVersion(rows[0]);
  }

  async insert(template: EmailTemplate, first: EmailTemplateVersion): Promise<boolean> {
    /*
     * `on conflict do nothing` with no target: a clash on the system key OR on
     * the one-default index is "somebody already made it", which is the
     * answer the caller wants — and, unlike a caught exception, it does not
     * abort the surrounding transaction.
     */
    const inserted = await this.db
      .insert(schema.emailTemplates)
      .values({
        id: template.id,
        event: template.event,
        jobType: template.jobType,
        name: template.name,
        description: template.description,
        active: template.active,
        isDefault: template.isDefault,
        currentVersion: template.currentVersion,
        systemKey: template.systemKey,
        createdAt: template.createdAt,
        createdBy: template.createdBy,
        updatedAt: template.updatedAt,
        updatedBy: template.updatedBy,
      })
      .onConflictDoNothing()
      .returning({ id: schema.emailTemplates.id });
    if (inserted.length === 0) return false;
    await this.addVersion(first);
    return true;
  }

  async addVersion(version: EmailTemplateVersion): Promise<void> {
    await this.db.insert(schema.emailTemplateVersions).values({
      id: version.id,
      templateId: version.templateId,
      version: version.version,
      subject: version.subject,
      body: version.body,
      changeNote: version.changeNote,
      createdAt: version.createdAt,
      createdBy: version.createdBy,
    });
  }

  async update(template: EmailTemplate): Promise<void> {
    await this.db
      .update(schema.emailTemplates)
      .set({
        name: template.name,
        description: template.description,
        active: template.active,
        isDefault: template.isDefault,
        currentVersion: template.currentVersion,
        updatedAt: template.updatedAt,
        updatedBy: template.updatedBy,
      })
      .where(eq(schema.emailTemplates.id, template.id));
  }
}

const toEmail = (row: EmailRow): CustomerEmail => ({
  id: row.id,
  idempotencyKey: row.idempotencyKey,
  event: row.event as EmailEvent,
  jobId: row.jobId,
  templateId: row.templateId,
  templateVersionId: row.templateVersionId,
  templateName: row.templateName,
  templateVersion: row.templateVersion,
  sender: row.sender,
  recipient: row.recipient,
  cc: row.cc,
  subject: row.subject,
  body: row.body,
  attachment:
    row.attachmentStorageKey === null
      ? null
      : { storageKey: row.attachmentStorageKey, fileName: row.attachmentFileName ?? '', sha256: row.attachmentSha256 },
  state: row.state as CustomerEmailState,
  attempts: row.attempts,
  nextAttemptAt: row.nextAttemptAt as IsoDateTime | null,
  lastAttemptAt: row.lastAttemptAt as IsoDateTime | null,
  sentAt: row.sentAt as IsoDateTime | null,
  providerRequestId: row.providerRequestId,
  failureKind: row.failureKind,
  failureReason: row.failureReason,
  retryOf: row.retryOf,
  createdAt: row.createdAt as IsoDateTime,
  createdBy: row.createdBy,
  updatedAt: row.updatedAt as IsoDateTime,
});

export class PostgresCustomerEmailRepository implements CustomerEmailRepository {
  constructor(private readonly db: DatabaseExecutor) {}

  async insert(email: CustomerEmail): Promise<'inserted' | 'duplicate'> {
    const inserted = await this.db
      .insert(schema.emailMessages)
      .values({
        id: email.id,
        idempotencyKey: email.idempotencyKey,
        event: email.event,
        jobId: email.jobId,
        templateId: email.templateId,
        templateVersionId: email.templateVersionId,
        templateName: email.templateName,
        templateVersion: email.templateVersion,
        sender: email.sender,
        recipient: email.recipient,
        cc: [...email.cc],
        subject: email.subject,
        body: email.body,
        attachmentStorageKey: email.attachment?.storageKey ?? null,
        attachmentFileName: email.attachment?.fileName ?? null,
        attachmentSha256: email.attachment?.sha256 ?? null,
        state: email.state,
        attempts: email.attempts,
        nextAttemptAt: email.nextAttemptAt,
        lastAttemptAt: email.lastAttemptAt,
        sentAt: email.sentAt,
        providerRequestId: email.providerRequestId,
        failureKind: email.failureKind,
        failureReason: email.failureReason.slice(0, 2000),
        retryOf: email.retryOf,
        createdAt: email.createdAt,
        createdBy: email.createdBy,
        updatedAt: email.updatedAt,
      })
      // The idempotency key and the one-live-per-document index both mean
      // "this email exists already". Neither aborts the transaction.
      .onConflictDoNothing()
      .returning({ id: schema.emailMessages.id });
    return inserted.length === 0 ? 'duplicate' : 'inserted';
  }

  async findById(id: string): Promise<CustomerEmail | null> {
    const rows = await this.db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, id)).limit(1);
    return rows[0] === undefined ? null : toEmail(rows[0]);
  }

  async findByIdempotencyKey(key: string): Promise<CustomerEmail | null> {
    const rows = await this.db
      .select()
      .from(schema.emailMessages)
      .where(eq(schema.emailMessages.idempotencyKey, key))
      .limit(1);
    return rows[0] === undefined ? null : toEmail(rows[0]);
  }

  async listForJob(jobId: JobId): Promise<readonly CustomerEmail[]> {
    const rows = await this.db
      .select()
      .from(schema.emailMessages)
      .where(eq(schema.emailMessages.jobId, jobId))
      .orderBy(desc(schema.emailMessages.createdAt))
      .limit(200);
    return rows.map(toEmail);
  }

  async list(limit: number): Promise<readonly CustomerEmail[]> {
    const rows = await this.db.select().from(schema.emailMessages).orderBy(desc(schema.emailMessages.createdAt)).limit(limit);
    return rows.map(toEmail);
  }

  async claimDue(now: IsoDateTime, limit: number): Promise<readonly CustomerEmail[]> {
    const claimed = await this.db.execute<EmailRow>(sql`
      update ${schema.emailMessages}
         set state = 'sending',
             attempts = attempts + 1,
             last_attempt_at = ${now},
             updated_at = ${now}
       where id in (
         select id from ${schema.emailMessages}
          where state = 'queued'
            and (next_attempt_at is null or next_attempt_at <= ${now})
          order by next_attempt_at asc nulls first, created_at asc
          limit ${limit}
          for update skip locked
       )
      returning *
    `);
    // A raw query returns column names, not drizzle's property names.
    return [...claimed].map((row) => {
      const raw = row as unknown as Record<string, unknown>;
      return toEmail({
        id: raw.id,
        idempotencyKey: raw.idempotency_key,
        event: raw.event,
        jobId: raw.job_id,
        templateId: raw.template_id,
        templateVersionId: raw.template_version_id,
        templateName: raw.template_name,
        templateVersion: raw.template_version,
        sender: raw.sender,
        recipient: raw.recipient,
        cc: raw.cc,
        subject: raw.subject,
        body: raw.body,
        attachmentStorageKey: raw.attachment_storage_key,
        attachmentFileName: raw.attachment_file_name,
        attachmentSha256: raw.attachment_sha256,
        state: raw.state,
        attempts: raw.attempts,
        nextAttemptAt: iso(raw.next_attempt_at),
        lastAttemptAt: iso(raw.last_attempt_at),
        sentAt: iso(raw.sent_at),
        providerRequestId: raw.provider_request_id,
        failureKind: raw.failure_kind,
        failureReason: raw.failure_reason,
        retryOf: raw.retry_of,
        createdAt: iso(raw.created_at),
        createdBy: raw.created_by,
        updatedAt: iso(raw.updated_at),
      } as EmailRow);
    });
  }

  async listStuckSending(before: IsoDateTime): Promise<readonly CustomerEmail[]> {
    const rows = await this.db
      .select()
      .from(schema.emailMessages)
      .where(and(eq(schema.emailMessages.state, 'sending'), lt(schema.emailMessages.lastAttemptAt, before)))
      .limit(50);
    return rows.map(toEmail);
  }

  async recordOutcome(
    id: string,
    outcome: Pick<CustomerEmail, 'state' | 'nextAttemptAt' | 'sentAt' | 'providerRequestId' | 'failureKind' | 'failureReason' | 'updatedAt'>,
  ): Promise<void> {
    await this.db
      .update(schema.emailMessages)
      .set({
        state: outcome.state,
        nextAttemptAt: outcome.nextAttemptAt,
        sentAt: outcome.sentAt,
        providerRequestId: outcome.providerRequestId,
        failureKind: outcome.failureKind,
        failureReason: outcome.failureReason.slice(0, 2000),
        updatedAt: outcome.updatedAt,
      })
      .where(and(eq(schema.emailMessages.id, id), sql`${schema.emailMessages.state} <> 'sent'`));
  }
}

const iso = (value: unknown): string | null =>
  value === null || value === undefined ? null : value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();

export class PostgresIntegrationRepository implements IntegrationRepository {
  constructor(private readonly db: DatabaseExecutor) {}

  async recordWebhookEvent(event: WhatsAppWebhookEvent): Promise<boolean> {
    try {
      const inserted = await this.db
        .insert(schema.whatsappWebhookEvents)
        .values({ ...event })
        .onConflictDoNothing()
        .returning({ id: schema.whatsappWebhookEvents.id });
      return inserted.length > 0;
    } catch (cause) {
      if (isUniqueViolation(cause)) return false;
      throw cause;
    }
  }

  async listWebhookEvents(limit: number): Promise<readonly WhatsAppWebhookEvent[]> {
    const rows = await this.db
      .select()
      .from(schema.whatsappWebhookEvents)
      .orderBy(desc(schema.whatsappWebhookEvents.receivedAt))
      .limit(limit);
    return rows.map((row) => ({
      ...row,
      occurredAt: row.occurredAt as IsoDateTime | null,
      receivedAt: row.receivedAt as IsoDateTime,
    }));
  }

  async findGeocode(queryKey: string, now: IsoDateTime): Promise<GeocodeCacheEntry | null> {
    const rows = await this.db
      .select()
      .from(schema.geocodeCache)
      .where(and(eq(schema.geocodeCache.queryKey, queryKey), gt(schema.geocodeCache.expiresAt, now)))
      .limit(1);
    const row = rows[0];
    return row === undefined
      ? null
      : { ...row, createdAt: row.createdAt as IsoDateTime, expiresAt: row.expiresAt as IsoDateTime };
  }

  async saveGeocode(entry: GeocodeCacheEntry): Promise<void> {
    await this.db
      .insert(schema.geocodeCache)
      .values({ ...entry, result: { ...entry.result } })
      .onConflictDoUpdate({
        target: schema.geocodeCache.queryKey,
        set: { provider: entry.provider, outcome: entry.outcome, result: { ...entry.result }, createdAt: entry.createdAt, expiresAt: entry.expiresAt },
      });
  }

  async countRequest(day: string, service: string): Promise<number> {
    const rows = await this.db
      .insert(schema.integrationUsage)
      .values({ day, service, requests: 1 })
      .onConflictDoUpdate({
        target: [schema.integrationUsage.day, schema.integrationUsage.service],
        set: { requests: sql`${schema.integrationUsage.requests} + 1` },
      })
      .returning({ requests: schema.integrationUsage.requests });
    return rows[0]?.requests ?? 1;
  }

  async requestsOn(day: string, service: string): Promise<number> {
    const rows = await this.db
      .select({ requests: schema.integrationUsage.requests })
      .from(schema.integrationUsage)
      .where(and(eq(schema.integrationUsage.day, day), eq(schema.integrationUsage.service, service)))
      .limit(1);
    return rows[0]?.requests ?? 0;
  }

  async findState(service: string): Promise<{ readonly fingerprint: string; readonly summary: string } | null> {
    const rows = await this.db.select().from(schema.integrationState).where(eq(schema.integrationState.service, service)).limit(1);
    return rows[0] === undefined ? null : { fingerprint: rows[0].fingerprint, summary: rows[0].summary };
  }

  async saveState(service: string, fingerprint: string, summary: string, at: IsoDateTime): Promise<void> {
    await this.db
      .insert(schema.integrationState)
      .values({ service, fingerprint, summary, updatedAt: at })
      .onConflictDoUpdate({ target: schema.integrationState.service, set: { fingerprint, summary, updatedAt: at } });
  }
}
