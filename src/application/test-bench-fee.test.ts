import { beforeEach, describe, expect, it } from 'vitest';
import { calculateJobTotals, type Job } from '@/domain';
import { buildJobCardModel } from '@/lib/job-card/model';
import { formatCurrency } from '@/lib/format';
import {
  acceptJob,
  addLabour,
  captureSignature,
  saveCompletionReport,
  addPart,
  setTestBenchApplied,
  setTestBenchQuantity,
  startCompletion,
  startSignature,
} from './job-operations';
import { updateSettings } from './settings-operations';
import { loadJobView } from './job-view';
import { buildHarness, seedUser, type Harness } from './test-harness';

/**
 * BENCH-1 — THE TEST BENCH FEE (the owner's instruction of 27 October 2026).
 *
 * Configurable by a Master or a Coordinator like the other rates; ticked per
 * job beside the call-out; optional and off by default; charged once; on the
 * job card; and frozen at signature, so a later change to the fee never
 * reprices a signed job.
 */
const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');
const technician = seedUser('user-tech-sipho');

let harness: Harness;
beforeEach(() => {
  harness = buildHarness();
});

const setFee = async (actor = master, cents = 45_000) => {
  const current = await harness.repos.settings.get();
  return updateSettings(harness.as(actor), { ...current, testBenchFee: cents });
};

const inProgress = async (): Promise<Job> => {
  const opened = await harness.repos.jobs.findByJobNumber('EJE-1048');
  return acceptJob(harness.as(technician), opened!);
};

describe('configuring the test bench fee', () => {
  it('is set by a Master or a Coordinator, persisted and audited', async () => {
    await setFee(master, 50_000);
    expect((await harness.repos.settings.get()).testBenchFee).toBe(50_000);
    await setFee(coordinator, 52_500);
    expect((await harness.repos.settings.get()).testBenchFee).toBe(52_500);
    const trail = await harness.repos.activity.list(undefined);
    expect(trail.some((event) => event.type === 'settings_updated' && /test bench fee/.test(event.detail))).toBe(true);
  });

  it('is refused to a technician', async () => {
    await expect(setFee(technician, 1)).rejects.toMatchObject({ violations: [{ code: 'not_permitted' }] });
  });
});

describe('the test bench fee on a job', () => {
  it('is off by default and charges nothing until ticked', async () => {
    await setFee();
    const job = await inProgress();
    expect(job.testBenchApplied).toBe(false);
    const totals = calculateJobTotals(job, await harness.repos.settings.get());
    expect(totals.testBenchTotal).toBe(0);
    expect(totals.testBenchLines).toHaveLength(0);
  });

  it('when ticked, adds the configured fee ONCE — ticking again changes nothing', async () => {
    await setFee(master, 45_000);
    const before = calculateJobTotals(await inProgress(), await harness.repos.settings.get());
    let job = (await harness.repos.jobs.findByJobNumber('EJE-1048'))!;
    job = await setTestBenchApplied(harness.as(technician), job, true);
    job = await setTestBenchApplied(harness.as(technician), job, true);
    const after = calculateJobTotals(job, await harness.repos.settings.get());
    expect(after.testBenchLines).toHaveLength(1);
    expect(after.testBenchTotal).toBe(45_000);
    expect(after.grossSubtotal).toBe(before.grossSubtotal + 45_000);
    expect(after.vat).toBe(Math.round((after.subtotal * after.pricing.vatPercentage) / 100));
    // Audited once: the second tick was no change.
    const changes = (await harness.repos.activity.list(job.id)).filter((event) => event.type === 'test_bench_changed');
    expect(changes).toHaveLength(1);
    // Unticked: gone again.
    job = await setTestBenchApplied(harness.as(technician), job, false);
    expect(calculateJobTotals(job, await harness.repos.settings.get()).testBenchTotal).toBe(0);
  });

  it('prints on the job card with the configured amount', async () => {
    await setFee(master, 45_000);
    await setTestBenchApplied(harness.as(technician), await inProgress(), true);
    const view = (await loadJobView(harness.repos, 'EJE-1048'))!;
    const model = buildJobCardModel({ ...view, generatedAt: '2026-10-27T10:00:00.000Z' });
    const row = model.charges?.rows.find((candidate) => candidate.description === 'Test bench fee');
    expect(row?.amount).toBe(formatCurrency(45_000));
  });

  it('is refused on a parts collection, like the call-out', async () => {
    const job = await inProgress();
    await expect(setTestBenchApplied(harness.as(technician), { ...job, jobType: 'parts' }, true)).rejects.toMatchObject({
      violations: [{ code: 'not_applicable_to_job_type' }],
    });
  });

  it('is frozen at signature: changing the fee afterwards does not reprice the signed job', async () => {
    await setFee(master, 45_000);
    const tech = harness.as(technician);
    let job = await setTestBenchApplied(tech, await inProgress(), true);
    job = await saveCompletionReport(tech, job, { ...job.completionReport, workPerformed: 'Bench tested the unit.' });
    job = await addLabour(tech, job, { date: '2026-10-27', rateType: 'normal', hours: 1, description: '' });
    job = await startCompletion(tech, job);
    job = await startSignature(tech, job);
    job = await captureSignature(tech, job, { customerName: 'A', customerSurname: 'B', strokeData: 'M0 0 L1 1' });
    expect(job.pricingSnapshot?.testBenchFee).toBe(45_000);

    await setFee(master, 99_000);
    const signed = (await harness.repos.jobs.findByJobNumber('EJE-1048'))!;
    const totals = calculateJobTotals(signed, await harness.repos.settings.get());
    expect(totals.testBenchTotal).toBe(45_000);
    // And it can no longer be unticked on the signed job.
    await expect(setTestBenchApplied(tech, signed, false)).rejects.toBeDefined();
  });

  it('reads a snapshot taken before the fee existed as no fee', () => {
    const totals = calculateJobTotals(
      {
        labour: [],
        travel: [],
        parts: [],
        additionalCharges: [],
        discount: null,
        calloutApplied: false,
        testBenchApplied: false,
        pricingSnapshot: {
          labourRates: { normal: 1, overtime: 1, double: 1 },
          calloutRate: 1,
          kilometreRate: 1,
          vatPercentage: 15,
          capturedAt: '2026-01-01T00:00:00.000Z',
          reason: 'customer_signature',
        },
      },
      { testBenchFee: 77_700 } as never,
    );
    expect(totals.testBenchTotal).toBe(0);
  });
});

/*
 * BENCH-QTY-1 (the tester, 1 November 2026): a quantity on the test bench fee —
 * 1 by default, changeable, validated, quantity × rate into the subtotal, VAT
 * and total, printed with its quantity, rate and amount; signed prices never
 * altered; nothing else repriced.
 */
describe('the quantity of the test bench fee', () => {
  const benchJob = async (fee = 45_000) => {
    await setFee(master, fee);
    return setTestBenchApplied(harness.as(technician), await inProgress(), true);
  };

  it('is 1 by default — exactly the single fee it always was', async () => {
    const job = await benchJob();
    expect(job.testBenchQuantity).toBe(1);
    const totals = calculateJobTotals(job, await harness.repos.settings.get());
    expect(totals.testBenchLines[0]).toMatchObject({ quantity: 1, unitPrice: 45_000, total: 45_000 });
  });

  it('charges quantity × rate, and the subtotal, VAT and total follow — with several parts on the job too', async () => {
    let job = await benchJob(45_000);
    const office = harness.as(coordinator);
    job = await addPart(office, job, { partNumber: 'BRG-001', description: 'Bearing', quantity: 2, unitPrice: 12_500 });
    job = await addPart(office, job, { partNumber: 'SK-010', description: 'Seal kit', quantity: 1, unitPrice: 8_000 });
    const single = calculateJobTotals(job, await harness.repos.settings.get());
    job = await setTestBenchQuantity(office, job, 3);
    expect(job.testBenchQuantity).toBe(3);
    const triple = calculateJobTotals(job, await harness.repos.settings.get());
    expect(triple.testBenchLines[0]).toMatchObject({ quantity: 3, unitPrice: 45_000, total: 135_000 });
    expect(triple.testBenchTotal).toBe(135_000);
    expect(triple.partsTotal).toBe(single.partsTotal);
    expect(triple.partsTotal).toBe(2 * 12_500 + 8_000);
    expect(triple.grossSubtotal).toBe(single.grossSubtotal + 90_000);
    expect(triple.vat).toBe(Math.round((triple.subtotal * triple.pricing.vatPercentage) / 100));
    expect(triple.total).toBe(triple.subtotal + triple.vat);
    // Nothing else moved.
    expect(triple.labourTotal).toBe(single.labourTotal);
    expect(triple.calloutTotal).toBe(single.calloutTotal);
    expect(triple.travelTotal).toBe(single.travelTotal);
    const changed = (await harness.repos.activity.list(job.id)).filter((event) => event.type === 'test_bench_changed');
    expect(changed.flatMap((event) => event.changes ?? []).filter((change) => change.field === 'test bench.quantity')).toEqual([{ field: 'test bench.quantity', from: 1, to: 3 }]);
  });

  it('prints its quantity, rate and amount on the job card, beside the parts', async () => {
    let job = await benchJob(45_000);
    job = await addPart(harness.as(technician), job, { partNumber: 'BRG-001', description: 'Bearing', quantity: 2, unitPrice: 12_500 });
    await setTestBenchQuantity(harness.as(technician), job, 2);
    const view = (await loadJobView(harness.repos, 'EJE-1048'))!;
    const model = buildJobCardModel({ ...view, generatedAt: '2026-11-01T10:00:00.000Z' });
    const row = model.charges?.rows.find((candidate) => candidate.description === 'Test bench fee');
    expect(row).toMatchObject({ quantity: '2', rate: formatCurrency(45_000), amount: formatCurrency(90_000) });
  });

  it('refuses a quantity that is not a whole number from 1 to 99, and a quantity with the fee not applied', async () => {
    const job = await benchJob();
    for (const bad of [0, -1, 100, 1.5, Number.NaN]) {
      await expect(setTestBenchQuantity(harness.as(technician), job, bad)).rejects.toMatchObject({
        violations: [{ code: 'invalid_test_bench_quantity' }],
      });
    }
    const unticked = await setTestBenchApplied(harness.as(technician), job, false);
    await expect(setTestBenchQuantity(harness.as(technician), unticked, 2)).rejects.toMatchObject({
      violations: [{ code: 'test_bench_not_applied' }],
    });
  });

  it('is frozen at signature with the rate: a signed job keeps quantity × the signed rate', async () => {
    const tech = harness.as(technician);
    let job = await benchJob(45_000);
    job = await setTestBenchQuantity(tech, job, 2);
    job = await saveCompletionReport(tech, job, { ...job.completionReport, workPerformed: 'Bench tested twice.' });
    job = await addLabour(tech, job, { date: '2026-10-27', rateType: 'normal', hours: 1, description: '' });
    job = await startCompletion(tech, job);
    job = await startSignature(tech, job);
    await captureSignature(tech, job, { customerName: 'A', customerSurname: 'B', strokeData: 'M0 0 L1 1' });
    await setFee(master, 99_000);
    const signed = (await harness.repos.jobs.findByJobNumber('EJE-1048'))!;
    expect(calculateJobTotals(signed, await harness.repos.settings.get()).testBenchTotal).toBe(90_000);
    await expect(setTestBenchQuantity(tech, signed, 3)).rejects.toBeDefined();
    expect((await harness.repos.jobs.findByJobNumber('EJE-1048'))!.testBenchQuantity).toBe(2);
  });

  it('reads a job written before the quantity existed as quantity 1 — its amount unchanged', () => {
    const totals = calculateJobTotals(
      {
        labour: [], travel: [], parts: [], additionalCharges: [], discount: null, calloutApplied: false, testBenchApplied: true,
        pricingSnapshot: {
          labourRates: { normal: 1, overtime: 1, double: 1 }, calloutRate: 1, kilometreRate: 1, vatPercentage: 15,
          testBenchFee: 45_000, capturedAt: '2026-10-28T00:00:00.000Z', reason: 'customer_signature',
        },
      },
      { testBenchFee: 77_700 } as never,
    );
    expect(totals.testBenchLines[0]).toMatchObject({ quantity: 1, total: 45_000 });
  });

  it('may not be set by a technician who is not on the job', async () => {
    const job = await benchJob();
    await expect(setTestBenchQuantity(harness.as(seedUser('user-tech-riaan')), job, 2)).rejects.toMatchObject({
      violations: [{ code: 'not_on_job' }],
    });
  });
});
