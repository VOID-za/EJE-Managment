import { beforeEach, describe, expect, it } from 'vitest';
import { acceptJob, returnJobToOpen, sendSiteLocation, transferJobToTechnician } from './job-operations';
import { ASSIGNMENT_TEMPLATE, TRANSFER_TEMPLATE } from './assignment-notice';
import { applyWhatsAppWebhook, listJobWhatsAppMessages, retryWhatsAppMessage } from './whatsapp-messages';
import { buildHarness, seedUser, type Harness } from './test-harness';
import { UnconfiguredWhatsAppService } from '@/services/production/whatsapp';
import { parseWebhook } from '@/services/production/whatsapp-webhook';
import type { Job } from '@/domain';

/**
 * INT-WA-1..3: who is told, when, with what — and what Meta's webhooks then
 * say about it. The notification rules are the owner's, exactly:
 *
 *   direct assignment → the assigned technician
 *   transfer          → the receiving technician, and nobody else
 *   Open Jobs         → nobody
 *   acceptance        → the technician is OFFERED the site location
 *   WhatsApp down     → nothing about the job changes
 */

const sipho = seedUser('user-tech-sipho');
const riaan = seedUser('user-tech-riaan');
const master = seedUser('user-master-elmarie');
const technician = sipho;
const REASON = { reason: 'vehicle_problem' as const, description: '' };

const whatsappFor = async (harness: Harness, job: Job) =>
  (await harness.repos.outbox.list(500)).filter((message) => message.jobId === job.id && message.channel === 'whatsapp');

const accepted = async (harness: Harness) =>
  acceptJob(harness.as(sipho), (await harness.repos.jobs.findByJobNumber('EJE-1048'))!);

describe('who is told', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('a transfer notifies ONLY the receiving technician, with the transfer template and six variables', async () => {
    const job = await accepted(harness);
    const before = await whatsappFor(harness, job);
    await transferJobToTechnician(harness.as(sipho), job, riaan.id, REASON);
    const added = (await whatsappFor(harness, job)).slice(0, (await whatsappFor(harness, job)).length - before.length);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ template: TRANSFER_TEMPLATE, purpose: 'transfer', recipient: riaan.mobile });
    const [jobNumber, jobType, customer, site, machine, link] = added[0]!.parameters;
    expect(jobNumber).toBe('EJE-1048');
    expect(jobType).toBe('Breakdown');
    expect(customer!.length).toBeGreaterThan(0);
    expect(site!.length).toBeGreaterThan(0);
    expect(machine!.length).toBeGreaterThan(0);
    expect(link).toBe('https://eje.syncza.co.za/jobs/EJE-1048');
  });

  it('a lock-screen-safe message: no fault description, no contact, no street address in the variables', async () => {
    const job = await accepted(harness);
    await transferJobToTechnician(harness.as(sipho), job, riaan.id, REASON);
    const [message] = await whatsappFor(harness, job);
    const joined = message!.parameters.join(' | ');
    expect(joined).not.toContain(job.faultDescription.slice(0, 20));
    expect(joined).not.toMatch(/@|\+27|0\d{9}/u);
  });

  it('a job returned to Open Jobs notifies nobody', async () => {
    const job = await accepted(harness);
    const before = (await harness.repos.outbox.list(500)).length;
    await returnJobToOpen(harness.as(sipho), job, REASON);
    expect((await harness.repos.outbox.list(500)).length).toBe(before);
  });

  it('acceptance stands when WhatsApp is not configured, and the location offer says nothing was sent', async () => {
    const unconfigured = buildHarness({ whatsapp: new UnconfiguredWhatsAppService() });
    const job = await acceptJob(unconfigured.as(sipho), (await unconfigured.repos.jobs.findByJobNumber('EJE-1048'))!);
    expect(job.status).toBe('in_progress');
    const site = (await unconfigured.repos.customers.findSiteById(job.siteId!))!;
    const customer = (await unconfigured.repos.customers.findById(job.customerId))!;
    const result = await sendSiteLocation(unconfigured.as(sipho), job, { site, machine: null, customerName: customer.name });
    expect(result).toMatchObject({ queued: false, configured: false });
    expect(result.navigationUrl).toContain('google.com/maps');
    expect(result.navigationNote.length).toBeGreaterThan(0);
    expect((await unconfigured.repos.jobs.findById(job.id))?.status).toBe('in_progress');
  });

  it('the location the technician asks for uses the JOB’S site, its pin when trusted', async () => {
    const job = await accepted(harness);
    const site = (await harness.repos.customers.findSiteById(job.siteId!))!;
    const customer = (await harness.repos.customers.findById(job.customerId))!;
    const result = await sendSiteLocation(harness.as(sipho), job, { site, machine: null, customerName: customer.name });
    const expected = site.latitude === null ? encodeURIComponent(site.addressLine1).slice(0, 10) : `${site.latitude}%2C${site.longitude}`;
    expect(result.navigationUrl).toContain(expected);
    const [message] = (await whatsappFor(harness, job)).filter((entry) => entry.purpose === 'site_location');
    expect(message?.parameters[5]).toBe(result.navigationUrl);
  });

  it('the assignment template is the one approved name', () => {
    expect(ASSIGNMENT_TEMPLATE).toBe('eje_job_assigned');
    expect(TRANSFER_TEMPLATE).toBe('eje_job_transferred');
  });
});

const webhook = (statuses: unknown[]) =>
  parseWebhook({ entry: [{ changes: [{ field: 'messages', value: { statuses } }] }] });

describe('what Meta says afterwards', () => {
  let harness: Harness;
  let messageId: string;
  let job: Job;
  beforeEach(async () => {
    harness = buildHarness();
    job = await accepted(harness);
    await transferJobToTechnician(harness.as(sipho), job, riaan.id, REASON);
    const [message] = await whatsappFor(harness, job);
    messageId = message!.id;
    await harness.repos.outbox.markSent(messageId, 'wamid.TEST', harness.services.clock.now());
  });

  it('moves a message forward — delivered, then read — and never back', async () => {
    const context = harness.as(master);
    await applyWhatsAppWebhook(context, webhook([{ id: 'wamid.TEST', status: 'delivered', timestamp: '100' }]));
    expect((await harness.repos.outbox.findById(messageId))?.deliveryStatus).toBe('delivered');
    await applyWhatsAppWebhook(context, webhook([{ id: 'wamid.TEST', status: 'read', timestamp: '101' }]));
    // A late "sent" arrives after "read": ignored.
    await applyWhatsAppWebhook(context, webhook([{ id: 'wamid.TEST', status: 'sent', timestamp: '99' }]));
    const message = await harness.repos.outbox.findById(messageId);
    expect(message?.deliveryStatus).toBe('read');
    expect(message?.deliveredAt).not.toBeNull();
    expect(message?.readAt).not.toBeNull();
  });

  it('applies a repeated webhook ONCE', async () => {
    const body = webhook([{ id: 'wamid.TEST', status: 'failed', timestamp: '100', errors: [{ code: 131026, title: 'Message undeliverable' }] }]);
    const first = await applyWhatsAppWebhook(harness.as(master), body);
    const second = await applyWhatsAppWebhook(harness.as(master), body);
    expect(first).toMatchObject({ applied: 1, duplicates: 0 });
    expect(second).toMatchObject({ applied: 0, duplicates: 1 });
    const failures = (await harness.repos.activity.list(job.id)).filter((event) => event.type === 'whatsapp_delivery_failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.detail).toContain('131026 Message undeliverable');
    // The job is untouched by a message failing.
    expect((await harness.repos.jobs.findById(job.id))?.primaryTechnicianId).toBe(riaan.id);
  });

  it('records a status for a message EJE never sent, without acting on it', async () => {
    const outcome = await applyWhatsAppWebhook(harness.as(master), webhook([{ id: 'wamid.UNKNOWN', status: 'delivered', timestamp: '1' }]));
    expect(outcome).toMatchObject({ applied: 0, unmatched: 1 });
  });

  it('lets the office retry a FAILED message once, as a new message, and refuses anything else', async () => {
    await expect(retryWhatsAppMessage(harness.as(master), messageId)).rejects.toThrow(/Only a failed message/u);
    await applyWhatsAppWebhook(harness.as(master), webhook([{ id: 'wamid.TEST', status: 'failed', timestamp: '5', errors: [{ code: 131049 }] }]));
    await expect(retryWhatsAppMessage(harness.as(technician), messageId)).rejects.toThrow(/Only the office/u);
    const retry = await retryWhatsAppMessage(harness.as(master), messageId);
    expect(retry).toMatchObject({ state: 'pending', retryOf: messageId, template: TRANSFER_TEMPLATE, recipient: riaan.mobile });
    await expect(retryWhatsAppMessage(harness.as(master), messageId)).rejects.toThrow(/already retried/u);
    const trail = (await harness.repos.activity.list(job.id)).map((event) => event.type);
    expect(trail).toContain('whatsapp_retried');
  });

  it('shows the office the job’s messages, and not a technician', async () => {
    expect(await listJobWhatsAppMessages(harness.as(master), job.id)).not.toHaveLength(0);
    await expect(listJobWhatsAppMessages(harness.as(technician), job.id)).rejects.toThrow(/Only the office/u);
  });

  it('records template review results on the trail, and tells the office about a rejection', async () => {
    await applyWhatsAppWebhook(
      harness.as(master),
      parseWebhook({ entry: [{ changes: [{ field: 'message_template_status_update', value: { event: 'REJECTED', message_template_name: 'eje_job_transferred', reason: 'TAG_CONTENT_MISMATCH' } }] }] }),
    );
    const events = (await harness.repos.activity.list()).filter((event) => event.type === 'whatsapp_template_status');
    expect(events[0]?.summary).toBe('WhatsApp template eje_job_transferred: REJECTED');
    const coordinatorNotes = await harness.repos.notifications.list(seedUser('user-coord-christene').id);
    expect(coordinatorNotes.some((note) => /REJECTED/u.test(note.title))).toBe(true);
  });
});
