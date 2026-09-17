import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptJob,
  addLabour,
  addPart,
  addTravel,
  removeLineItem,
  submitForMasterReview,
  updateLabour,
  updatePart,
  updateTravel,
} from './job-operations';
import { WorkflowError } from './errors';
import { loadJobView } from './job-view';
import type { OperationContext } from './context';
import { createDemoRepositories } from '@/data/demo/repositories';
import { DemoStore } from '@/data/demo/demo-store';
import { SimulatedEmailService } from '@/services/simulated/email';
import { SimulatedOutbox } from '@/services/simulated/outbox';
import { SimulatedPdfService } from '@/services/simulated/pdf';
import { inMemoryFileStore, SimulatedStorageService } from '@/services/simulated/storage';
import { SequentialIdGenerator, SystemClock } from '@/services/simulated/system';
import { SimulatedWhatsAppService } from '@/services/simulated/whatsapp';
import { seedUsers } from '@/data/seed';
import { calculateJobTotals, type Job, type SystemSettings } from '@/domain';
import type { RepositoryBundle } from '@/data/repositories';

/**
 * Amending captured work.
 *
 * A technician mistypes hours or a part number far more often than they capture
 * nothing at all, so every line has to be correctable — and correcting one must
 * recalculate the job without disturbing the pricing snapshot.
 */
const technician = seedUsers.find((user) => user.id === 'user-tech-sipho')!;

interface Harness {
  readonly context: OperationContext;
  readonly repos: RepositoryBundle;
}

const build = (): Harness => {
  const store = new DemoStore();
  const repos = createDemoRepositories({ read: store.read, commit: store.commit });
  const clock = new SystemClock();
  const ids = new SequentialIdGenerator();
  const outbox = new SimulatedOutbox();

  return {
    repos,
    context: {
      repos,
      actor: technician,
      services: {
        clock,
        ids,
        email: new SimulatedEmailService(outbox, clock, ids),
        whatsapp: new SimulatedWhatsAppService(outbox, clock, ids),
        pdf: new SimulatedPdfService(clock),
        storage: new SimulatedStorageService(inMemoryFileStore()),
      },
    },
  };
};

const acceptedJob = async (harness: Harness): Promise<Job> => {
  const view = await loadJobView(harness.repos, 'EJE-1048');
  return acceptJob(harness.context, view!.job);
};

const totalsOf = async (harness: Harness, job: Job) =>
  calculateJobTotals(job, (await harness.repos.settings.get()) as SystemSettings);

describe('labour lines can be amended', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = build();
  });

  it('changes the hours and recalculates the total', async () => {
    let job = await acceptedJob(harness);
    job = await addLabour(harness.context, job, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 2,
      description: 'Fault finding',
    });
    const before = await totalsOf(harness, job);

    const lineId = job.labour[0]!.id;
    job = await updateLabour(harness.context, job, lineId, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 5,
      description: 'Fault finding and repair',
    });
    const after = await totalsOf(harness, job);

    expect(job.labour).toHaveLength(1);
    expect(job.labour[0]?.hours).toBe(5);
    expect(job.labour[0]?.description).toBe('Fault finding and repair');
    expect(after.labourTotal).toBe(before.labourTotal * 2.5);
    expect(after.total).toBeGreaterThan(before.total);
  });

  it('re-prices when the rate type changes', async () => {
    let job = await acceptedJob(harness);
    job = await addLabour(harness.context, job, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 2,
      description: 'Work',
    });
    const before = await totalsOf(harness, job);

    job = await updateLabour(harness.context, job, job.labour[0]!.id, {
      date: '2026-09-17',
      rateType: 'overtime',
      hours: 2,
      description: 'Work',
    });
    const after = await totalsOf(harness, job);

    expect(after.labourTotal).toBeGreaterThan(before.labourTotal);
    expect(after.labourLines[0]?.unitPrice).toBe(after.pricing.labourRates.overtime);
  });

  it('keeps the line id and original capture time', async () => {
    let job = await acceptedJob(harness);
    job = await addLabour(harness.context, job, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 2,
      description: 'Work',
    });
    const original = job.labour[0]!;

    job = await updateLabour(harness.context, job, original.id, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 3,
      description: 'Work',
    });

    expect(job.labour[0]?.id).toBe(original.id);
    expect(job.labour[0]?.capturedAt).toBe(original.capturedAt);
  });

  it('refuses to amend a line that is not on the job', async () => {
    const job = await acceptedJob(harness);
    await expect(
      updateLabour(harness.context, job, 'no-such-line', {
        date: '2026-09-17',
        rateType: 'normal',
        hours: 1,
        description: '',
      }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });
});

describe('travel and parts lines can be amended', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = build();
  });

  it('recalculates travel when the distance changes', async () => {
    let job = await acceptedJob(harness);
    job = await addTravel(harness.context, job, {
      date: '2026-09-17',
      kilometres: 40,
      description: 'Return trip',
    });
    const before = await totalsOf(harness, job);

    job = await updateTravel(harness.context, job, job.travel[0]!.id, {
      date: '2026-09-17',
      kilometres: 80,
      description: 'Return trip, corrected',
    });
    const after = await totalsOf(harness, job);

    expect(job.travel[0]?.kilometres).toBe(80);
    expect(after.travelTotal).toBe(before.travelTotal * 2);
  });

  it('recalculates parts when quantity or price changes', async () => {
    let job = await acceptedJob(harness);
    job = await addPart(harness.context, job, {
      partNumber: 'FAN-24V-80',
      description: 'Cooling fan',
      quantity: 1,
      unitPrice: 48500,
    });
    const before = await totalsOf(harness, job);

    job = await updatePart(harness.context, job, job.parts[0]!.id, {
      partNumber: 'FAN-24V-80B',
      description: 'Cooling fan, revised part',
      quantity: 3,
      unitPrice: 50000,
    });
    const after = await totalsOf(harness, job);

    expect(job.parts[0]?.partNumber).toBe('FAN-24V-80B');
    expect(job.parts[0]?.quantity).toBe(3);
    expect(before.partsTotal).toBe(48500);
    expect(after.partsTotal).toBe(150000);
  });

  it('removes a line and drops it from the total', async () => {
    let job = await acceptedJob(harness);
    job = await addPart(harness.context, job, {
      partNumber: 'X-1',
      description: 'Part',
      quantity: 1,
      unitPrice: 10000,
    });
    job = await removeLineItem(harness.context, job, 'part', job.parts[0]!.id);

    expect(job.parts).toHaveLength(0);
    expect((await totalsOf(harness, job)).partsTotal).toBe(0);
  });
});

describe('amending does not disturb historical pricing', () => {
  it('prices an amendment at the snapshot rates, not current settings', async () => {
    const harness = build();
    const rates = await harness.repos.settings.get();

    let job = await acceptedJob(harness);
    job = await addLabour(harness.context, job, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 2,
      description: 'Work',
    });

    // Freeze the job by pushing it through signature and hand-over.
    const frozen: Job = {
      ...job,
      status: 'review',
      completionReport: { ...job.completionReport, workPerformed: 'Done.' },
      signature: {
        customerName: 'Pieter',
        customerSurname: 'Nel',
        strokeData: 'M0,0 L1,1',
        signedAt: '2026-09-17T15:00:00.000Z',
        declaration: 'I confirm that the work described above has been completed.',
      },
      pricingSnapshot: {
        labourRates: { ...rates.labourRates },
        calloutRate: rates.calloutRate,
        kilometreRate: rates.kilometreRate,
        vatPercentage: rates.vatPercentage,
        capturedAt: '2026-09-17T15:00:00.000Z',
        reason: 'customer_signature',
      },
    };
    await harness.repos.jobs.save(frozen);
    const handed = await submitForMasterReview(harness.context, frozen);

    // Rates change afterwards.
    await harness.repos.settings.save({
      ...rates,
      labourRates: { normal: 999000, overtime: 999000, double: 999000 },
    });

    const master = seedUsers.find((user) => user.role === 'master')!;
    const masterContext: OperationContext = { ...harness.context, actor: master };
    const amended = await updateLabour(masterContext, handed, handed.labour[0]!.id, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 4,
      description: 'Work, corrected',
    });

    const totals = await totalsOf(harness, amended);
    expect(totals.pricing.labourRates.normal).toBe(rates.labourRates.normal);
    expect(totals.labourTotal).toBe(rates.labourRates.normal * 4);
  });

  it('records a post-signature amendment on the audit trail', async () => {
    const harness = build();
    const master = seedUsers.find((user) => user.role === 'master')!;
    const masterContext: OperationContext = { ...harness.context, actor: master };

    let job = await acceptedJob(harness);
    job = await addPart(harness.context, job, {
      partNumber: 'X-1',
      description: 'Part',
      quantity: 1,
      unitPrice: 10000,
    });

    const inReview: Job = { ...job, status: 'submitted' };
    await harness.repos.jobs.save(inReview);

    await updatePart(masterContext, inReview, inReview.parts[0]!.id, {
      partNumber: 'X-2',
      description: 'Part',
      quantity: 2,
      unitPrice: 10000,
    });

    const trail = await harness.repos.activity.list(job.id);
    expect(trail.some((event) => event.type === 'master_amended_after_signature')).toBe(true);
  });
});
