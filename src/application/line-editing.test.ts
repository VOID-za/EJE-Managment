import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptJob,
  addLabour,
  addPart,
  addTravel,
  removeLineItem,
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
import { builtinPdfText } from '@/services/pdf-text';
import { inMemoryFileStore, DemoStorageService } from '@/services/simulated/storage';
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
        pdfText: builtinPdfText(),
        storage: new DemoStorageService(inMemoryFileStore()),
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

/**
 * WHAT WAS TAKEN OFF THE JOB, AND BY WHOM. AUDIT-3.
 *
 * A removal is the one edit that takes money OFF what the customer is asked to
 * pay, and until this it recorded nothing on any reachable path: the
 * `recordPostSignatureChange` call in `removeLineItem` cannot fire for a signed
 * job, because `assertEditable` refuses that first. So a three-hour labour line
 * could be deleted and nothing anywhere said it had ever existed — which is
 * exactly what an invoice dispute asks about six months later.
 */
describe('a removed line is recorded', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = build();
  });

  const eventsFor = async (job: Job) =>
    (await harness.repos.activity.list(job.id)).filter(
      (event) => event.type === 'line_item_removed',
    );

  it('records WHICH labour line went, with every field it carried', async () => {
    let job = await acceptedJob(harness);
    job = await addLabour(harness.context, job, {
      date: '2026-09-17',
      rateType: 'overtime',
      hours: 3,
      description: 'Stripped the spindle housing',
    });
    job = await removeLineItem(harness.context, job, 'labour', job.labour[0]!.id);

    const [event] = await eventsFor(job);
    expect(event?.summary).toContain('Labour removed');
    expect(event?.actorId).toBe(technician.id);

    // AUDIT-2's shape, used for a disappearance: every field, going to null.
    const changes = Object.fromEntries(
      (event?.changes ?? []).map((change) => [change.field, change]),
    );
    expect(changes['labour.hours']).toEqual({ field: 'labour.hours', from: 3, to: null });
    expect(changes['labour.rateType']?.from).toBe('overtime');
    expect(changes['labour.date']?.from).toBe('2026-09-17');
    expect(changes['labour.description']?.from).toBe('Stripped the spindle housing');
    for (const change of event?.changes ?? []) expect(change.to).toBeNull();
  });

  it('records a removed travel line and a removed part the same way', async () => {
    let job = await acceptedJob(harness);
    job = await addTravel(harness.context, job, {
      date: '2026-09-17',
      kilometres: 120,
      description: 'Benoni and back',
    });
    job = await addPart(harness.context, job, {
      partNumber: 'FAN-24V-80B',
      description: 'Cabinet fan',
      quantity: 2,
      unitPrice: 24250,
    });

    job = await removeLineItem(harness.context, job, 'travel', job.travel[0]!.id);
    job = await removeLineItem(harness.context, job, 'part', job.parts[0]!.id);

    const events = await eventsFor(job);
    expect(events).toHaveLength(2);

    const travel = events.find((event) => event.summary.startsWith('Travel removed'));
    expect(travel?.changes.find((change) => change.field === 'travel.kilometres')?.from).toBe(120);

    const part = events.find((event) => event.summary.startsWith('Part removed'));
    expect(part?.summary).toContain('FAN-24V-80B');
    expect(part?.changes.find((change) => change.field === 'part.quantity')?.from).toBe(2);
    expect(part?.changes.find((change) => change.field === 'part.unitPrice')?.from).toBe(24250);
  });

  it('REFUSES to remove a line that is not on the job, and records nothing', async () => {
    /*
     * It used to filter nothing, save, and report success — so a stale screen
     * could be told its deletion went through a second time.
     */
    const job = await acceptedJob(harness);
    await expect(removeLineItem(harness.context, job, 'labour', 'line-that-never-existed'))
      .rejects.toThrow(WorkflowError);

    expect(await eventsFor(job)).toHaveLength(0);
  });

  it('names every field of the line, so the list cannot drift from the values', async () => {
    /*
     * `LINE_FIELDS` supplies the keys a removal reports as null and
     * `lineItemValues` supplies the values. If one gains a field and the other
     * does not, the trail silently stops recording it — so the two are compared
     * here through the only thing that sees both: a real removal.
     */
    let job = await acceptedJob(harness);
    job = await addLabour(harness.context, job, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 1,
      description: 'One hour',
    });
    job = await addTravel(harness.context, job, {
      date: '2026-09-17',
      kilometres: 10,
      description: 'Ten kilometres',
    });
    job = await addPart(harness.context, job, {
      partNumber: 'P-1',
      description: 'A part',
      quantity: 1,
      unitPrice: 100,
    });

    const expected: Record<string, readonly string[]> = {
      labour: ['labour.date', 'labour.rateType', 'labour.hours', 'labour.description'],
      travel: ['travel.date', 'travel.kilometres', 'travel.description'],
      part: ['part.partNumber', 'part.description', 'part.quantity', 'part.unitPrice'],
    };

    for (const kind of ['labour', 'travel', 'part'] as const) {
      const lineId =
        kind === 'labour' ? job.labour[0]!.id : kind === 'travel' ? job.travel[0]!.id : job.parts[0]!.id;
      job = await removeLineItem(harness.context, job, kind, lineId);

      const event = (await eventsFor(job)).find((candidate) =>
        candidate.changes.some((change) => change.field.startsWith(`${kind}.`)),
      );
      expect(event?.changes.map((change) => change.field).sort(), kind).toEqual(
        [...expected[kind]!].sort(),
      );
    }
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
    const handed = frozen;

    // Rates change afterwards.
    await harness.repos.settings.save({
      ...rates,
      labourRates: { normal: 999000, overtime: 999000, double: 999000 },
    });

    const master = seedUsers.find((user) => user.role === 'master')!;
    const masterContext: OperationContext = { ...harness.context, actor: master };

    /*
     * MASTER SCOPE CR-01. This case amended the SIGNED job to show that the
     * amendment priced at the frozen rates. The amendment itself is now
     * refused — a customer-signed job card is legally final — so the rule it
     * was demonstrating is asserted where it actually lives: on the snapshot.
     */
    await expect(
      updateLabour(masterContext, handed, handed.labour[0]!.id, {
        date: '2026-09-17',
        rateType: 'normal',
        hours: 4,
        description: 'Work, corrected',
      }),
    ).rejects.toThrow(/final and cannot be changed/i);

    const totals = await totalsOf(harness, handed);
    expect(totals.pricing.labourRates.normal).toBe(rates.labourRates.normal);
    expect(totals.labourTotal).toBe(rates.labourRates.normal * 2);
  });

  it('can no longer produce a post-signature amendment event', async () => {
    /*
     * MASTER SCOPE CR-01. This asserted the opposite: that amending a job the
     * customer had signed was recorded as `master_amended_after_signature`.
     * That event was an honest record of something the business now prohibits,
     * so nothing produces it any more.
     *
     * The TYPE stays in `ActivityEventType` on purpose — jobs amended under
     * the old rule carry it, and removing it would make their history
     * unreadable. This holds it unreachable rather than deleted.
     */
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
    expect(trail.some((event) => event.type === 'master_amended_after_signature')).toBe(false);
  });
});
