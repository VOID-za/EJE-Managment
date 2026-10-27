import { beforeEach, describe, expect, it } from 'vitest';
import { offersSiteLocation } from '@/domain';
import {
  SITE_LOCATION_TEMPLATE,
  acceptJob,
  buildSiteLocationMessage,
  declineSiteLocation,
  sendSiteLocation,
} from './job-operations';
import { loadJobView } from './job-view';
import type { OperationContext } from './context';
import { createDemoRepositories } from '@/data/demo/repositories';
import { DemoStore } from '@/data/demo/demo-store';
import { SimulatedEmailService } from '@/services/simulated/email';
import { SimulatedOutbox } from '@/services/simulated/outbox';
import { SimulatedPdfService } from '@/services/simulated/pdf';
import { builtinPdfText } from '@/services/pdf-text';
import { inMemoryFileStore, DemoStorageService } from '@/services/simulated/storage';
import { SequentialIdGenerator, SystemClock } from '@/services/simulated/system';
import { SimulatedWhatsAppService } from '@/services/simulated/whatsapp';
import { seedUsers } from '@/data/seed';
import type { RepositoryBundle } from '@/data/repositories';
import type { OutboxEntry, WhatsAppMessage, WhatsAppService } from '@/services/ports';
import type { User } from '@/domain';

/**
 * Optional site location on acceptance.
 *
 * The rule that matters commercially: accepting a job and sending a WhatsApp are
 * two separate things. The job is accepted first and stays accepted whatever
 * happens to the message — including when WhatsApp is completely broken.
 *
 * *Amended 18 October 2026, WHATSAPP-1.* The message is no longer handed to the
 * provider inside the operation. It is ENQUEUED on the durable outbox with the
 * transaction that records the request, and sent afterwards by the dispatcher —
 * the same mechanism the assignment notice uses, and for the same two reasons:
 * no database transaction is held open across a call to Meta, and a commit can
 * no longer lose the obligation. So these tests assert the OUTBOX ROW, and that
 * the result says `queued` rather than claiming a send nobody has made yet.
 */

const actor: User = seedUsers.find((user) => user.id === 'user-tech-sipho')!;

/** A WhatsApp adapter that always fails, standing in for a provider outage. */
class FailingWhatsAppService implements WhatsAppService {
  readonly configured = true;

  send(_message: WhatsAppMessage): Promise<OutboxEntry> {
    return Promise.reject(new Error('WhatsApp Cloud API unavailable (503)'));
  }
}

/** A deployment with no WhatsApp credentials at all. */
class UnconfiguredService implements WhatsAppService {
  readonly configured = false;

  send(_message: WhatsAppMessage): Promise<OutboxEntry> {
    return Promise.reject(new Error('WhatsApp is not configured on this deployment.'));
  }
}

interface Harness {
  readonly context: OperationContext;
  readonly repos: RepositoryBundle;
  readonly outbox: SimulatedOutbox;
}

const build = (whatsapp?: WhatsAppService): Harness => {
  const store = new DemoStore();
  const repos = createDemoRepositories({ read: store.read, commit: store.commit });
  const clock = new SystemClock();
  const ids = new SequentialIdGenerator();
  const outbox = new SimulatedOutbox();

  return {
    repos,
    outbox,
    context: {
      repos,
      actor,
      services: {
        clock,
        ids,
        email: new SimulatedEmailService(outbox, clock, ids),
        whatsapp: whatsapp ?? new SimulatedWhatsAppService(outbox, clock, ids),
        pdf: new SimulatedPdfService(clock),
        pdfText: builtinPdfText(),
        storage: new DemoStorageService(inMemoryFileStore()),
      },
    },
  };
};

const acceptEje1048 = async (harness: Harness) => {
  const view = await loadJobView(harness.repos, 'EJE-1048');
  expect(view).not.toBeNull();

  const accepted = await acceptJob(harness.context, view!.job);
  expect(accepted.status).toBe('in_progress');

  return {
    job: accepted,
    input: {
      site: view!.site,
      machine: view!.machine,
      customerName: view!.customer.name,
    },
  };
};

describe('acceptance does not send anything on its own', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = build();
  });

  it('leaves the outbox empty after a job is accepted', async () => {
    await acceptEje1048(harness);
    expect(harness.outbox.listSync()).toHaveLength(0);
  });

  it('records acceptance without any site-location entry', async () => {
    const { job } = await acceptEje1048(harness);
    const trail = await harness.repos.activity.list(job.id);
    const types = trail.map((event) => event.type);

    expect(types).toContain('job_accepted');
    expect(types).not.toContain('site_location_sent');
    expect(types).not.toContain('site_location_declined');
  });
});

describe('choosing "Send Location"', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = build();
  });

  it('queues exactly one WhatsApp message on the durable outbox', async () => {
    const { job, input } = await acceptEje1048(harness);
    const result = await sendSiteLocation(harness.context, job, input);

    expect(result.queued).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.failureReason).toBeNull();

    const queued = (await harness.repos.outbox.list()).filter((row) => row.jobId === job.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.channel).toBe('whatsapp');
    expect(queued[0]?.template).toBe(SITE_LOCATION_TEMPLATE);
    // The actor's OWN number, from their account — never one in a request.
    expect(queued[0]?.recipient).toBe(actor.mobile);
    expect(queued[0]?.state).toBe('pending');
    expect(queued[0]?.attempts).toBe(0);
    expect(queued[0]?.providerMessageId).toBeNull();
  });

  it('hands the provider NOTHING while the operation is running', async () => {
    /*
     * The architectural point, asserted: a provider that rejects every call
     * cannot affect this operation, because the operation does not call it.
     * The row is written, and the dispatcher sends it after the commit.
     */
    const outage = build(new FailingWhatsAppService());
    const { job, input } = await acceptEje1048(outage);

    const result = await sendSiteLocation(outage.context, job, input);

    expect(result.queued).toBe(true);
    expect(outage.outbox.listSync()).toHaveLength(0);
    expect((await outage.repos.outbox.list()).filter((row) => row.jobId === job.id)).toHaveLength(1);
  });

  it('includes the job number, customer, machine, site and a navigation link', async () => {
    const { job, input } = await acceptEje1048(harness);
    await sendSiteLocation(harness.context, job, input);

    const row = (await harness.repos.outbox.list()).find((entry) => entry.jobId === job.id);
    const body = row?.preview ?? '';
    expect(body).toContain('EJE-1048');
    expect(body).toContain('ABC Engineering (Pty) Ltd');
    expect(body).toContain('Leadwell V-40');
    expect(body).toContain('Johannesburg');
    expect(body).toContain('https://www.google.com/maps/dir/?api=1&destination=');
    // The template's placeholders, in the order the approved template expects.
    expect(row?.parameters[0]).toBe('EJE-1048');
    expect(row?.parameters[4]).toContain('google.com/maps');
  });

  it('keeps the message short, to limit notifications and messaging cost', async () => {
    const { job, input } = await acceptEje1048(harness);
    const body = buildSiteLocationMessage(input, job.jobNumber);

    expect(body.split('\n')).toHaveLength(4);
    expect(body.length).toBeLessThan(320);
  });

  it('records it on the audit trail, saying queued is not sent', async () => {
    const { job, input } = await acceptEje1048(harness);
    await sendSiteLocation(harness.context, job, input);

    const trail = await harness.repos.activity.list(job.id);
    const entry = trail.find((event) => event.type === 'site_location_sent');
    expect(entry?.summary).toBe('Site location requested via WhatsApp');
    expect(entry?.detail).toContain('Queued is not sent');
  });

  it('queues NOTHING on a deployment with no WhatsApp configuration, and says so', async () => {
    /*
     * A row that can never be sent would be retried until its attempts ran out
     * and would sit on the office's outbox screen as a failure nobody can act
     * on. The honest answer is given now, and the technician still has the
     * link on their screen.
     */
    const unconfigured = build(new UnconfiguredService());
    const { job, input } = await acceptEje1048(unconfigured);

    const result = await sendSiteLocation(unconfigured.context, job, input);

    expect(result.queued).toBe(false);
    expect(result.configured).toBe(false);
    expect(result.failureReason).toMatch(/not set up/iu);
    expect(result.navigationUrl).toContain('google.com/maps');
    expect(await unconfigured.repos.outbox.list()).toHaveLength(0);

    const trail = await unconfigured.repos.activity.list(job.id);
    const failure = trail.find((event) => event.type === 'site_location_failed');
    expect(failure?.detail).toMatch(/not configured/iu);
    expect(failure?.detail).toContain('remains accepted');
  });

  it('queues nothing, and says so, when the technician has no mobile number', async () => {
    const harnessWithoutNumber = build();
    const { job, input } = await acceptEje1048(harnessWithoutNumber);
    const withoutNumber: OperationContext = {
      ...harnessWithoutNumber.context,
      actor: { ...actor, mobile: '   ' },
    };

    const result = await sendSiteLocation(withoutNumber, job, input);

    expect(result.queued).toBe(false);
    // Configured, but unreachable: a thing the office can fix, so it is said.
    expect(result.configured).toBe(true);
    expect(result.failureReason).toMatch(/no mobile number/iu);
    expect(await harnessWithoutNumber.repos.outbox.list()).toHaveLength(0);
  });
});

describe('choosing "No, Thanks"', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = build();
  });

  it('sends nothing at all', async () => {
    const { job } = await acceptEje1048(harness);
    await declineSiteLocation(harness.context, job);
    expect(harness.outbox.listSync()).toHaveLength(0);
  });

  it('records the choice without affecting the job', async () => {
    const { job } = await acceptEje1048(harness);
    await declineSiteLocation(harness.context, job);

    const trail = await harness.repos.activity.list(job.id);
    expect(trail.find((event) => event.type === 'site_location_declined')?.summary).toBe(
      'Site location not requested',
    );

    const reloaded = await harness.repos.jobs.findByJobNumber('EJE-1048');
    expect(reloaded?.status).toBe('in_progress');
    expect(reloaded?.acceptedAt).not.toBeNull();
  });
});

describe('WhatsApp failure never affects the job', () => {
  it('leaves the job accepted and in progress, with the message still queued', async () => {
    /*
     * The provider is down. The job was accepted before any of this and stays
     * accepted — and because the message is a durable row rather than an HTTP
     * call made inside the operation, the obligation survives the outage
     * instead of becoming one sentence on the audit trail with nothing to
     * retry from. `outbox-dispatch.test.ts` covers what the dispatcher then
     * does with it.
     */
    const harness = build(new FailingWhatsAppService());
    const { job, input } = await acceptEje1048(harness);

    const result = await sendSiteLocation(harness.context, job, input);
    expect(result.queued).toBe(true);

    const reloaded = await harness.repos.jobs.findByJobNumber('EJE-1048');
    expect(reloaded?.status).toBe('in_progress');
    expect(reloaded?.acceptedAt).not.toBeNull();

    const row = (await harness.repos.outbox.list()).find((entry) => entry.jobId === job.id);
    expect(row?.state).toBe('pending');
  });

  it('does not reject, so a caller cannot accidentally roll acceptance back', async () => {
    const harness = build(new FailingWhatsAppService());
    const { job, input } = await acceptEje1048(harness);
    await expect(sendSiteLocation(harness.context, job, input)).resolves.toBeDefined();
  });
});

describe('PIN-1 — no pin location for a Parts or a Test & Repair job (27 October 2026)', () => {
  it.each(['parts', 'test_and_repair'] as const)('refuses to queue a site location for a %s job, and queues nothing', async (jobType) => {
    const harness = build();
    const { job, input } = await acceptEje1048(harness);
    const other = { ...job, jobType };
    await expect(sendSiteLocation(harness.context, other, input)).rejects.toMatchObject({
      violations: [{ code: 'not_applicable_to_job_type' }],
    });
    expect((await harness.repos.outbox.list()).filter((row) => row.template === SITE_LOCATION_TEMPLATE)).toHaveLength(0);
    expect(harness.outbox.listSync()).toHaveLength(0);
  });

  it('still offers it on the job types that go to the customer’s site', () => {
    expect(offersSiteLocation('parts')).toBe(false);
    expect(offersSiteLocation('test_and_repair')).toBe(false);
    for (const code of ['breakdown', 'service', 'installation'] as const) {
      expect(offersSiteLocation(code), code).toBe(true);
    }
  });

  it('a breakdown still queues exactly one site location, unchanged', async () => {
    const harness = build();
    const { job, input } = await acceptEje1048(harness);
    expect(job.jobType).not.toBe('parts');
    const result = await sendSiteLocation(harness.context, job, input);
    expect(result.queued).toBe(true);
    expect((await harness.repos.outbox.list()).filter((row) => row.template === SITE_LOCATION_TEMPLATE)).toHaveLength(1);
  });
});
