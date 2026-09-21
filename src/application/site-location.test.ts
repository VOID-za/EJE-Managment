import { beforeEach, describe, expect, it } from 'vitest';
import {
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
 */

const actor: User = seedUsers.find((user) => user.id === 'user-tech-sipho')!;

/** A WhatsApp adapter that always fails, standing in for a provider outage. */
class FailingWhatsAppService implements WhatsAppService {
  send(_message: WhatsAppMessage): Promise<OutboxEntry> {
    return Promise.reject(new Error('WhatsApp Cloud API unavailable (503)'));
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

  it('queues exactly one WhatsApp message', async () => {
    const { job, input } = await acceptEje1048(harness);
    const result = await sendSiteLocation(harness.context, job, input);

    expect(result.sent).toBe(true);
    expect(result.failureReason).toBeNull();

    const sent = harness.outbox.listSync();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.channel).toBe('whatsapp');
    expect(sent[0]?.to).toBe(actor.mobile);
    expect(sent[0]?.simulated).toBe(true);
  });

  it('includes the job number, customer, machine, site and a navigation link', async () => {
    const { job, input } = await acceptEje1048(harness);
    await sendSiteLocation(harness.context, job, input);

    const body = harness.outbox.listSync()[0]?.body ?? '';
    expect(body).toContain('EJE-1048');
    expect(body).toContain('ABC Engineering (Pty) Ltd');
    expect(body).toContain('Leadwell V-40');
    expect(body).toContain('Johannesburg');
    expect(body).toContain('https://www.google.com/maps/dir/?api=1&destination=');
  });

  it('keeps the message short, to limit notifications and messaging cost', async () => {
    const { job, input } = await acceptEje1048(harness);
    const body = buildSiteLocationMessage(input, job.jobNumber);

    expect(body.split('\n')).toHaveLength(4);
    expect(body.length).toBeLessThan(320);
  });

  it('records it on the audit trail', async () => {
    const { job, input } = await acceptEje1048(harness);
    await sendSiteLocation(harness.context, job, input);

    const trail = await harness.repos.activity.list(job.id);
    const entry = trail.find((event) => event.type === 'site_location_sent');
    expect(entry?.summary).toBe('Site location requested via WhatsApp');
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
  it('leaves the job accepted and in progress when the send fails', async () => {
    const harness = build(new FailingWhatsAppService());
    const { job, input } = await acceptEje1048(harness);

    const result = await sendSiteLocation(harness.context, job, input);

    // The operation reports the failure rather than throwing it at the caller.
    expect(result.sent).toBe(false);
    expect(result.failureReason).toContain('503');

    const reloaded = await harness.repos.jobs.findByJobNumber('EJE-1048');
    expect(reloaded?.status).toBe('in_progress');
    expect(reloaded?.acceptedAt).not.toBeNull();
  });

  it('records the failure on the trail so it is not lost', async () => {
    const harness = build(new FailingWhatsAppService());
    const { job, input } = await acceptEje1048(harness);
    await sendSiteLocation(harness.context, job, input);

    const trail = await harness.repos.activity.list(job.id);
    const failure = trail.find((event) => event.type === 'site_location_failed');
    expect(failure?.summary).toBe('Site location could not be sent');
    expect(failure?.detail).toContain('remains accepted');
  });

  it('does not reject, so a caller cannot accidentally roll acceptance back', async () => {
    const harness = build(new FailingWhatsAppService());
    const { job, input } = await acceptEje1048(harness);
    await expect(sendSiteLocation(harness.context, job, input)).resolves.toBeDefined();
  });
});
