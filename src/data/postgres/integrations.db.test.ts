import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Database } from '@/db/client';
import { IDS, jobFixture, seedBaseline } from './test-fixtures';
import { openTestDatabase, testDatabaseUrl, truncateAll } from './test-database';
import { PostgresJobRepository } from './job-repository';
import { PostgresCustomerRepository } from './customer-repository';
import { PostgresOutboxRepository } from './outbox-repository';
import {
  PostgresCustomerEmailRepository,
  PostgresEmailTemplateRepository,
  PostgresIntegrationRepository,
} from './integration-repositories';
import { asSiteId, locationAfterSave, siteLocationOf, type CustomerEmail, type EmailTemplate, type EmailTemplateVersion } from '@/domain';

/**
 * MIGRATION 0042 ON POSTGRESQL. INT-EMAIL, INT-WA, INT-MAP. The rules the
 * application relies on, held by the DATABASE: one default template per event
 * and job type, a template version never edited, one live email per job,
 * event and document, a sent email never changed, an email's content never
 * changed — and the repositories that read and write around them.
 */

const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : error instanceof Error ? error.message : String(error);
  }
  throw new Error('the statement was expected to be refused, and was not');
};

const NOW = '2026-11-01T08:00:00.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const template = (n: number, over: Partial<EmailTemplate> = {}): EmailTemplate => ({
  id: uuid(0x700 + n),
  event: 'signed_job_card',
  jobType: 'breakdown',
  name: `Template ${n}`,
  description: '',
  active: true,
  isDefault: false,
  currentVersion: 1,
  systemKey: null,
  createdAt: NOW,
  createdBy: null,
  updatedAt: NOW,
  updatedBy: null,
  ...over,
});
const version = (t: EmailTemplate, v = 1): EmailTemplateVersion => ({
  id: uuid(0x800 + v * 16 + Number.parseInt(t.id.slice(-2), 16)),
  templateId: t.id,
  version: v,
  subject: '{{job_number}}',
  body: 'Hello',
  changeNote: '',
  createdAt: NOW,
  createdBy: null,
});

describeDb('migration 0042 on PostgreSQL', () => {
  let db: Database;
  let jobId: string;

  beforeAll(async () => {
    db = await openTestDatabase(url ?? '');
  });
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await truncateAll(db);
    await seedBaseline(db);
    const jobs = new PostgresJobRepository(db);
    const allocated = await jobs.allocateJobNumber();
    jobId = (await jobs.save(jobFixture(allocated.jobNumber))).id;
  });

  const email = (n: number, over: Partial<CustomerEmail> = {}): CustomerEmail => ({
    id: uuid(0x900 + n),
    idempotencyKey: `signed_job_card:${jobId}:doc-1${n > 0 ? `:retry:${n}` : ''}`,
    event: 'signed_job_card',
    jobId,
    templateId: null,
    templateVersionId: null,
    templateName: 'T',
    templateVersion: 1,
    sender: 'sales@ejeie.co.za',
    recipient: 'customer@example.test',
    cc: [],
    subject: 'EJE — Signed',
    body: 'Hello',
    attachment: { storageKey: 'doc-1', fileName: 'EJE.pdf', sha256: 'a'.repeat(64) },
    state: 'queued',
    attempts: 0,
    nextAttemptAt: NOW,
    lastAttemptAt: null,
    sentAt: null,
    providerRequestId: null,
    failureKind: null,
    failureReason: '',
    retryOf: null,
    createdAt: NOW,
    createdBy: null,
    updatedAt: NOW,
    ...over,
  });

  describe('templates', () => {
    it('allow ONE default per event and job type, and a default must be active', async () => {
      const repo = new PostgresEmailTemplateRepository(db);
      const first = template(1, { isDefault: true });
      expect(await repo.insert(first, version(first))).toBe(true);
      // A second default is "already there" — refused without aborting the transaction.
      const second = template(2, { isDefault: true });
      expect(await repo.insert(second, version(second))).toBe(false);
      expect(await refusal(db.execute(sql`update email_templates set active = false where id = ${first.id}`))).toMatch(/default_is_active/u);
      expect((await repo.findDefault('signed_job_card', 'breakdown'))?.id).toBe(first.id);
    });

    it('never let a version be edited or deleted', async () => {
      const repo = new PostgresEmailTemplateRepository(db);
      const t = template(3);
      await repo.insert(t, version(t));
      expect(await refusal(db.execute(sql`update email_template_versions set body = 'changed' where template_id = ${t.id}`))).toMatch(/never changed/u);
      expect(await refusal(db.execute(sql`delete from email_template_versions where template_id = ${t.id}`))).toMatch(/never changed/u);
      await repo.addVersion(version(t, 2));
      await repo.update({ ...t, currentVersion: 2 });
      expect((await repo.findById(t.id))?.current.version).toBe(2);
      expect((await repo.versions(t.id)).map((v) => v.version)).toEqual([2, 1]);
    });

    it('a system template is created once, however many times it is ensured', async () => {
      const repo = new PostgresEmailTemplateRepository(db);
      const shipped = template(4, { systemKey: 'signed_job_card:breakdown' });
      expect(await repo.insert(shipped, version(shipped))).toBe(true);
      const again = template(5, { systemKey: 'signed_job_card:breakdown' });
      expect(await repo.insert(again, version(again))).toBe(false);
    });
  });

  describe('the customer email outbox', () => {
    it('one idempotency key, one email', async () => {
      const repo = new PostgresCustomerEmailRepository(db);
      expect(await repo.insert(email(0))).toBe('inserted');
      expect(await repo.insert({ ...email(0), id: uuid(0x9ff) })).toBe('duplicate');
    });

    it('ONE queued, sending or sent email per job, event and document — a failed one may be retried as a new one', async () => {
      const repo = new PostgresCustomerEmailRepository(db);
      await repo.insert(email(0));
      expect(await repo.insert(email(1))).toBe('duplicate');
      await repo.recordOutcome(email(0).id, { state: 'failed', nextAttemptAt: null, sentAt: null, providerRequestId: null, failureKind: 'provider_refused', failureReason: 'x', updatedAt: NOW });
      expect(await repo.insert(email(1))).toBe('inserted');
    });

    it('claims due emails once, with the attempt counted, and never one that is not due', async () => {
      const repo = new PostgresCustomerEmailRepository(db);
      await repo.insert(email(0));
      await repo.insert(email(2, { idempotencyKey: 'later', attachment: { storageKey: 'doc-2', fileName: 'b.pdf', sha256: null }, nextAttemptAt: '2026-11-02T08:00:00.000Z' }));
      const claimed = await repo.claimDue(NOW, 5);
      expect(claimed.map((entry) => entry.id)).toEqual([email(0).id]);
      expect(claimed[0]).toMatchObject({ state: 'sending', attempts: 1, recipient: 'customer@example.test', idempotencyKey: email(0).idempotencyKey });
      expect(claimed[0]?.lastAttemptAt).toBe(NOW);
      expect(await repo.claimDue(NOW, 5)).toEqual([]);
      expect((await repo.listStuckSending('2026-11-01T09:00:00.000Z')).map((entry) => entry.id)).toEqual([email(0).id]);
    });

    it('a SENT email is never changed or deleted, and no email’s content changes after it is written', async () => {
      const repo = new PostgresCustomerEmailRepository(db);
      await repo.insert(email(0));
      expect(await refusal(db.execute(sql`update email_messages set recipient = 'other@example.test' where id = ${email(0).id}`))).toMatch(/fixed when it is written/u);
      await repo.recordOutcome(email(0).id, { state: 'sent', nextAttemptAt: null, sentAt: NOW, providerRequestId: 'graph-request:1', failureKind: null, failureReason: '', updatedAt: NOW });
      // The repository's own update is a no-op on a sent email; a raw one is refused.
      await repo.recordOutcome(email(0).id, { state: 'failed', nextAttemptAt: null, sentAt: null, providerRequestId: null, failureKind: 'x', failureReason: 'x', updatedAt: NOW });
      expect((await repo.findById(email(0).id))?.state).toBe('sent');
      expect(await refusal(db.execute(sql`update email_messages set state = 'failed' where id = ${email(0).id}`))).toMatch(/never changed/u);
      expect(await refusal(db.execute(sql`delete from email_messages where id = ${email(0).id}`))).toMatch(/never deleted/u);
    });

    it('a sendable email must have a recipient', async () => {
      expect(await refusal(new PostgresCustomerEmailRepository(db).insert(email(0, { recipient: '' })))).toMatch(/sendable_has_recipient/u);
      expect(await new PostgresCustomerEmailRepository(db).insert(email(0, { recipient: '', state: 'attention', nextAttemptAt: null }))).toBe('inserted');
    });
  });

  describe('sites and the automatic pin', () => {
    it('round trips the pin record, and an answer for an address the site no longer has is dropped', async () => {
      const customers = new PostgresCustomerRepository(db);
      const site = (await customers.findSiteById(asSiteId(IDS.site)))!;
      // The fixture site has no address; one with an address is what is geocoded.
      const queued = locationAfterSave(null, { ...site, addressLine1: '3 Wadeville Boulevard', city: 'Germiston', latitude: null, longitude: null }, IDS.master, NOW);
      const saved = await customers.saveSite(queued);
      expect(siteLocationOf(saved)).toMatchObject({ status: 'pending', nextAttemptAt: NOW });
      expect((await customers.listSitesDueForGeocode(NOW, 5)).map((entry) => entry.id)).toEqual([site.id]);

      const query = siteLocationOf(saved).query;
      const answered = { ...saved, latitude: -26.2745, longitude: 28.198, geocode: { ...siteLocationOf(saved), status: 'resolved' as const, nextAttemptAt: null, formattedAddress: 'Google' } };
      expect(await customers.saveSiteLocation(answered, query)).toBe(true);
      expect(await customers.saveSiteLocation(answered, 'another address')).toBe(false);
      const reread = (await customers.findSiteById(site.id))!;
      expect(reread.latitude).toBe(-26.2745);
      expect(siteLocationOf(reread)).toMatchObject({ status: 'resolved', formattedAddress: 'Google' });
      expect(await customers.listSitesDueForGeocode(NOW, 5)).toEqual([]);
    });

    it('marks a pin entered before 0042 as the office’s own, verified (the backfill)', async () => {
      await db.execute(sql`update sites set latitude = -26.1, longitude = 28.1, location_status = 'not_requested', location_source = null where id = ${IDS.site}`);
      await db.execute(sql`
        update sites set location_status = 'verified', location_source = 'manual'
         where latitude is not null and longitude is not null and location_source is null and location_status = 'not_requested'`);
      const reread = await new PostgresCustomerRepository(db).findSiteById(asSiteId(IDS.site));
      expect(siteLocationOf(reread!)).toMatchObject({ status: 'verified', source: 'manual' });
    });

    it('refuses an unknown status and an impossible coordinate', async () => {
      expect(await refusal(db.execute(sql`update sites set location_status = 'guessed' where id = ${IDS.site}`))).toMatch(/location_status_known/u);
      expect(await refusal(db.execute(sql`update sites set latitude = 123 where id = ${IDS.site}`))).toMatch(/coordinates_in_range/u);
    });
  });

  describe('bookkeeping', () => {
    it('records a webhook status once, caches answers until they expire, and counts requests per day', async () => {
      const repo = new PostgresIntegrationRepository(db);
      const event = { id: 'evt-1', providerMessageId: 'wamid.1', status: 'delivered', errorCode: '', errorTitle: '', occurredAt: null, receivedAt: NOW, matched: false };
      expect(await repo.recordWebhookEvent(event)).toBe(true);
      expect(await repo.recordWebhookEvent(event)).toBe(false);

      await repo.saveGeocode({ queryKey: 'za|x', provider: 'google', outcome: 'match', result: { latitude: -26 }, createdAt: NOW, expiresAt: '2026-12-01T08:00:00.000Z' });
      expect((await repo.findGeocode('za|x', NOW))?.result).toEqual({ latitude: -26 });
      expect(await repo.findGeocode('za|x', '2026-12-02T08:00:00.000Z')).toBeNull();

      expect(await repo.countRequest('2026-11-01', 'google_geocoding')).toBe(1);
      expect(await repo.countRequest('2026-11-01', 'google_geocoding')).toBe(2);
      expect(await repo.requestsOn('2026-11-01', 'google_geocoding')).toBe(2);
      expect(await repo.requestsOn('2026-11-02', 'google_geocoding')).toBe(0);

      await repo.saveState('email', 'abc', 'Set: EMAIL_SENDER.', NOW);
      await repo.saveState('email', 'def', 'Set: nothing.', NOW);
      expect(await repo.findState('email')).toEqual({ fingerprint: 'def', summary: 'Set: nothing.' });
    });

    it('a WhatsApp message keeps what Meta reported, found by Meta’s id', async () => {
      const outbox = new PostgresOutboxRepository(db);
      await outbox.enqueue({
        id: uuid(0xa01), channel: 'whatsapp', template: 'eje_job_transferred', recipient: '27820000000', parameters: ['EJE-1'], preview: '',
        jobId: jobId as never, state: 'pending', attempts: 0, providerMessageId: null, failureReason: '', createdAt: NOW, lastAttemptAt: null, purpose: 'transfer',
      });
      await outbox.markSent(uuid(0xa01), 'wamid.TEST', NOW);
      const found = await outbox.findByProviderMessageId('wamid.TEST');
      expect(found).toMatchObject({ id: uuid(0xa01), purpose: 'transfer' });
      await outbox.recordDeliveryStatus(uuid(0xa01), 'read', NOW, '');
      expect(await outbox.findById(uuid(0xa01))).toMatchObject({ deliveryStatus: 'read', readAt: NOW, deliveredAt: NOW });
      await outbox.markFailed(uuid(0xa01), 'refused', NOW, true);
      expect((await outbox.findById(uuid(0xa01)))?.state).toBe('failed');
      expect((await outbox.listForJob(jobId as never)).map((message) => message.id)).toEqual([uuid(0xa01)]);
    });
  });
});
