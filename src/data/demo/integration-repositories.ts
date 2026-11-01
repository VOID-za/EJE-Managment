import type {
  CustomerEmail,
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
import type { DemoContext } from './repositories';

/**
 * Templates, the customer email outbox and the integrations' bookkeeping, in
 * the demonstration snapshot (and in every unit test). The SAME contracts as
 * PostgreSQL's: one default per event and job type, versions appended and
 * never changed, a sent email never changed, an email's content never changed
 * after it is written. Where PostgreSQL enforces a rule with a constraint,
 * this enforces it in code, so a test against the demo store proves the rule
 * the application relies on.
 */

const withCurrent = (template: EmailTemplate, versions: readonly EmailTemplateVersion[]): EmailTemplateWithVersion | null => {
  const current = versions.find((version) => version.templateId === template.id && version.version === template.currentVersion);
  return current === undefined ? null : { ...template, current };
};

export class DemoEmailTemplateRepository implements EmailTemplateRepository {
  constructor(private readonly context: DemoContext) {}

  private all(): EmailTemplateWithVersion[] {
    const data = this.context.read();
    return data.emailTemplates.flatMap((template) => {
      const found = withCurrent(template, data.emailTemplateVersions);
      return found === null ? [] : [found];
    });
  }

  list(): Promise<readonly EmailTemplateWithVersion[]> {
    return Promise.resolve(
      this.all().sort((a, b) => a.event.localeCompare(b.event) || a.jobType.localeCompare(b.jobType) || a.name.localeCompare(b.name)),
    );
  }

  findById(id: string): Promise<EmailTemplateWithVersion | null> {
    return Promise.resolve(this.all().find((template) => template.id === id) ?? null);
  }

  findDefault(event: EmailEvent, jobType: JobTypeCode): Promise<EmailTemplateWithVersion | null> {
    return Promise.resolve(
      this.all().find((template) => template.event === event && template.jobType === jobType && template.isDefault && template.active) ?? null,
    );
  }

  versions(templateId: string): Promise<readonly EmailTemplateVersion[]> {
    return Promise.resolve(
      this.context
        .read()
        .emailTemplateVersions.filter((version) => version.templateId === templateId)
        .sort((a, b) => b.version - a.version),
    );
  }

  findVersion(templateId: string, version: number): Promise<EmailTemplateVersion | null> {
    return Promise.resolve(
      this.context.read().emailTemplateVersions.find((candidate) => candidate.templateId === templateId && candidate.version === version) ?? null,
    );
  }

  insert(template: EmailTemplate, first: EmailTemplateVersion): Promise<boolean> {
    const data = this.context.read();
    const clash =
      (template.systemKey !== null && data.emailTemplates.some((existing) => existing.systemKey === template.systemKey)) ||
      (template.isDefault &&
        data.emailTemplates.some((existing) => existing.isDefault && existing.event === template.event && existing.jobType === template.jobType)) ||
      data.emailTemplates.some((existing) => existing.id === template.id);
    if (clash) return Promise.resolve(false);
    this.context.commit((draft) => {
      draft.emailTemplates = [...draft.emailTemplates, template];
      draft.emailTemplateVersions = [...draft.emailTemplateVersions, first];
    });
    return Promise.resolve(true);
  }

  addVersion(version: EmailTemplateVersion): Promise<void> {
    const exists = this.context
      .read()
      .emailTemplateVersions.some((candidate) => candidate.templateId === version.templateId && candidate.version === version.version);
    if (exists) return Promise.reject(new Error('That template version exists already; versions are never replaced.'));
    this.context.commit((draft) => {
      draft.emailTemplateVersions = [...draft.emailTemplateVersions, version];
    });
    return Promise.resolve();
  }

  update(template: EmailTemplate): Promise<void> {
    const data = this.context.read();
    if (template.isDefault && !template.active) {
      return Promise.reject(new Error('A default template must be active (email_templates_default_is_active).'));
    }
    if (
      template.isDefault &&
      data.emailTemplates.some(
        (existing) => existing.id !== template.id && existing.isDefault && existing.event === template.event && existing.jobType === template.jobType,
      )
    ) {
      return Promise.reject(new Error('Only one default template per event and job type (email_templates_one_default).'));
    }
    this.context.commit((draft) => {
      draft.emailTemplates = draft.emailTemplates.map((existing) =>
        existing.id === template.id
          ? {
              ...existing,
              name: template.name,
              description: template.description,
              active: template.active,
              isDefault: template.isDefault,
              currentVersion: template.currentVersion,
              updatedAt: template.updatedAt,
              updatedBy: template.updatedBy,
            }
          : existing,
      );
    });
    return Promise.resolve();
  }
}

const LIVE: readonly CustomerEmail['state'][] = ['queued', 'sending', 'sent'];

export class DemoCustomerEmailRepository implements CustomerEmailRepository {
  constructor(private readonly context: DemoContext) {}

  insert(email: CustomerEmail): Promise<'inserted' | 'duplicate'> {
    const existing = this.context.read().customerEmails;
    const duplicate =
      existing.some((candidate) => candidate.idempotencyKey === email.idempotencyKey || candidate.id === email.id) ||
      (LIVE.includes(email.state) &&
        existing.some(
          (candidate) =>
            LIVE.includes(candidate.state) &&
            candidate.jobId === email.jobId &&
            candidate.event === email.event &&
            (candidate.attachment?.storageKey ?? null) === (email.attachment?.storageKey ?? null),
        ));
    if (duplicate) return Promise.resolve('duplicate');
    if (LIVE.includes(email.state) && email.recipient.length === 0) {
      return Promise.reject(new Error('An email that can be sent needs a recipient (email_messages_sendable_has_recipient).'));
    }
    this.context.commit((draft) => {
      draft.customerEmails = [...draft.customerEmails, email];
    });
    return Promise.resolve('inserted');
  }

  findById(id: string): Promise<CustomerEmail | null> {
    return Promise.resolve(this.context.read().customerEmails.find((email) => email.id === id) ?? null);
  }

  findByIdempotencyKey(key: string): Promise<CustomerEmail | null> {
    return Promise.resolve(this.context.read().customerEmails.find((email) => email.idempotencyKey === key) ?? null);
  }

  listForJob(jobId: JobId): Promise<readonly CustomerEmail[]> {
    return Promise.resolve(
      this.context
        .read()
        .customerEmails.filter((email) => email.jobId === jobId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    );
  }

  list(limit: number): Promise<readonly CustomerEmail[]> {
    return Promise.resolve(
      [...this.context.read().customerEmails].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit),
    );
  }

  claimDue(now: IsoDateTime, limit: number): Promise<readonly CustomerEmail[]> {
    const due = this.context
      .read()
      .customerEmails.filter((email) => email.state === 'queued' && (email.nextAttemptAt === null || email.nextAttemptAt <= now))
      .sort((a, b) => (a.nextAttemptAt ?? '').localeCompare(b.nextAttemptAt ?? '') || a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit)
      .map((email): CustomerEmail => ({ ...email, state: 'sending', attempts: email.attempts + 1, lastAttemptAt: now, updatedAt: now }));
    this.context.commit((draft) => {
      draft.customerEmails = draft.customerEmails.map((email) => due.find((claimed) => claimed.id === email.id) ?? email);
    });
    return Promise.resolve(due);
  }

  listStuckSending(before: IsoDateTime): Promise<readonly CustomerEmail[]> {
    return Promise.resolve(
      this.context
        .read()
        .customerEmails.filter((email) => email.state === 'sending' && email.lastAttemptAt !== null && email.lastAttemptAt < before),
    );
  }

  recordOutcome(
    id: string,
    outcome: Pick<CustomerEmail, 'state' | 'nextAttemptAt' | 'sentAt' | 'providerRequestId' | 'failureKind' | 'failureReason' | 'updatedAt'>,
  ): Promise<void> {
    this.context.commit((draft) => {
      draft.customerEmails = draft.customerEmails.map((email) =>
        // A sent email is never changed — the database refuses it, and so does this.
        email.id === id && email.state !== 'sent' ? { ...email, ...outcome } : email,
      );
    });
    return Promise.resolve();
  }
}

export class DemoIntegrationRepository implements IntegrationRepository {
  constructor(private readonly context: DemoContext) {}

  recordWebhookEvent(event: WhatsAppWebhookEvent): Promise<boolean> {
    if (this.context.read().whatsappWebhookEvents.some((existing) => existing.id === event.id)) return Promise.resolve(false);
    this.context.commit((draft) => {
      // Bounded: the demonstration keeps the last thousand.
      draft.whatsappWebhookEvents = [...draft.whatsappWebhookEvents, event].slice(-1000);
    });
    return Promise.resolve(true);
  }

  listWebhookEvents(limit: number): Promise<readonly WhatsAppWebhookEvent[]> {
    return Promise.resolve(
      [...this.context.read().whatsappWebhookEvents].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, limit),
    );
  }

  findGeocode(queryKey: string, now: IsoDateTime): Promise<GeocodeCacheEntry | null> {
    return Promise.resolve(
      this.context.read().geocodeCache.find((entry) => entry.queryKey === queryKey && entry.expiresAt > now) ?? null,
    );
  }

  purgeExpiredGeocodes(now: IsoDateTime): Promise<number> {
    const expired = this.context.read().geocodeCache.filter((entry) => entry.expiresAt <= now).length;
    if (expired > 0) {
      this.context.commit((draft) => {
        draft.geocodeCache = draft.geocodeCache.filter((entry) => entry.expiresAt > now);
      });
    }
    return Promise.resolve(expired);
  }

  saveGeocode(entry: GeocodeCacheEntry): Promise<void> {
    this.context.commit((draft) => {
      draft.geocodeCache = [...draft.geocodeCache.filter((existing) => existing.queryKey !== entry.queryKey), entry];
    });
    return Promise.resolve();
  }

  countRequest(day: string, service: string): Promise<number> {
    let total = 0;
    this.context.commit((draft) => {
      const found = draft.integrationUsage.find((row) => row.day === day && row.service === service);
      total = (found?.requests ?? 0) + 1;
      draft.integrationUsage = [
        ...draft.integrationUsage.filter((row) => !(row.day === day && row.service === service)),
        { day, service, requests: total },
      ];
    });
    return Promise.resolve(total);
  }

  requestsOn(day: string, service: string): Promise<number> {
    return Promise.resolve(
      this.context.read().integrationUsage.find((row) => row.day === day && row.service === service)?.requests ?? 0,
    );
  }

  findState(service: string): Promise<{ readonly fingerprint: string; readonly summary: string } | null> {
    const found = this.context.read().integrationState.find((row) => row.service === service);
    return Promise.resolve(found === undefined ? null : { fingerprint: found.fingerprint, summary: found.summary });
  }

  saveState(service: string, fingerprint: string, summary: string, at: IsoDateTime): Promise<void> {
    this.context.commit((draft) => {
      draft.integrationState = [
        ...draft.integrationState.filter((row) => row.service !== service),
        { service, fingerprint, summary, updatedAt: at },
      ];
    });
    return Promise.resolve();
  }
}
