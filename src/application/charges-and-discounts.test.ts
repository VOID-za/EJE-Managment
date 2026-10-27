import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptJob,
  addAdditionalCharge,
  addLabour,
  removeLineItem,
  updateAdditionalCharge,
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
import {
  calculateJobTotals,
  materialisePricingSnapshot,
  type Job,
  type SystemSettings,
  type User,
} from '@/domain';
import type { RepositoryBundle } from '@/data/repositories';

/**
 * MONEY ON A JOB THAT IS NOT LABOUR, TRAVEL OR A PART. COST-5.
 *
 * WHAT THE OFFICE DID BEFORE. There were three places money could go, so a
 * consumable, a workshop bench fee or a sub-contractor's invoice went onto a
 * PART line with an invented part number — which is how a parts search starts
 * returning things that are not parts. And a discount agreed on the telephone
 * was applied on the invoice, outside this system, so the job card the customer
 * signed and the invoice they paid disagreed.
 *
 * WHAT IS ASSERTED HERE is the arithmetic and the authority, because those are
 * the two things a screen cannot be trusted with: VAT has to be charged on what
 * the customer actually pays, and what a customer is let off has to be somebody
 * nameable's decision.
 */
const technician = seedUsers.find((user) => user.id === 'user-tech-sipho')!;
const master = seedUsers.find((user) => user.role === 'master')!;

interface Harness {
  readonly context: OperationContext;
  readonly repos: RepositoryBundle;
  /**
   * The same store, a different person.
   *
   * A field job is ACCEPTED by the technician who attends it — a Master cannot
   * — and a discount is applied by a Master. Both acts happen to the same job,
   * so the harness has to be able to change who is acting without starting a
   * new store.
   */
  as(actor: User): OperationContext;
}

const build = (actor: User = technician): Harness => {
  const store = new DemoStore();
  const repos = createDemoRepositories({ read: store.read, commit: store.commit });
  const clock = new SystemClock();
  const ids = new SequentialIdGenerator();
  const outbox = new SimulatedOutbox();

  const services = {
    clock,
    ids,
    email: new SimulatedEmailService(outbox, clock, ids),
    whatsapp: new SimulatedWhatsAppService(outbox, clock, ids),
    pdf: new SimulatedPdfService(clock),
    pdfText: builtinPdfText(),
    storage: new DemoStorageService(inMemoryFileStore()),
  };

  return {
    repos,
    context: { repos, actor, services },
    as: (next: User) => ({ repos, actor: next, services }),
  };
};

const settingsOf = async (harness: Harness) =>
  (await harness.repos.settings.get()) as SystemSettings;

const totalsOf = async (harness: Harness, job: Job) =>
  calculateJobTotals(job, await settingsOf(harness));

/** A job with two hours of labour on it, so there is something to discount. */
const workedJob = async (harness: Harness): Promise<Job> => {
  const view = await loadJobView(harness.repos, 'EJE-1048');
  // Accepted and captured by the technician who attends it, whoever is acting
  // in the test: a Master cannot accept a field job, and that is correct.
  const field = harness.as(technician);
  const accepted = await acceptJob(field, view!.job);
  return addLabour(field, accepted, {
    date: '2026-10-21',
    rateType: 'normal',
    hours: 2,
    description: 'Fault finding',
  });
};

describe('an additional charge', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = build();
  });

  it('goes on the job as its own line, with its own total', async () => {
    let job = await workedJob(harness);
    const before = await totalsOf(harness, job);

    job = await addAdditionalCharge(harness.context, job, {
      description: 'Workshop consumables and cleaning materials',
      amount: 45_000,
    });
    const after = await totalsOf(harness, job);

    expect(job.additionalCharges).toHaveLength(1);
    expect(job.additionalCharges[0]?.amount).toBe(45_000);
    expect(after.additionalChargesTotal).toBe(45_000);
    // AND IT IS NOT A PART. The thing this requirement exists to stop is a
    // charge wearing a part number, so the parts collection must be untouched.
    expect(job.parts).toHaveLength(0);
    expect(after.partsTotal).toBe(before.partsTotal);
    expect(after.grossSubtotal).toBe(before.grossSubtotal + 45_000);
  });

  it('is charged VAT, like everything else on the job', async () => {
    let job = await workedJob(harness);
    job = await addAdditionalCharge(harness.context, job, {
      description: 'Courier on an air-freighted part',
      amount: 100_000,
    });
    const totals = await totalsOf(harness, job);

    // 15% of the subtotal, and the subtotal includes the charge. A charge that
    // escaped VAT would be an under-declaration, not a saving.
    expect(totals.vat).toBe(Math.round((totals.subtotal * totals.pricing.vatPercentage) / 100));
    expect(totals.total).toBe(totals.subtotal + totals.vat);
  });

  it('can be amended and removed like any other line', async () => {
    let job = await workedJob(harness);
    job = await addAdditionalCharge(harness.context, job, {
      description: 'Consumables',
      amount: 20_000,
    });
    const lineId = job.additionalCharges[0]!.id;

    job = await updateAdditionalCharge(harness.context, job, lineId, {
      description: 'Consumables and solvent',
      amount: 35_000,
    });
    expect(job.additionalCharges[0]?.amount).toBe(35_000);
    expect(job.additionalCharges[0]?.description).toBe('Consumables and solvent');

    job = await removeLineItem(harness.context, job, 'additional_charge', lineId);
    expect(job.additionalCharges).toHaveLength(0);
    expect((await totalsOf(harness, job)).additionalChargesTotal).toBe(0);
  });

  it('refuses to remove one that is no longer on the job', async () => {
    const job = await workedJob(harness);
    // A stale screen deleting twice must be told, not answered with success.
    await expect(
      removeLineItem(harness.context, job, 'additional_charge', 'chg-nothing'),
    ).rejects.toThrow(WorkflowError);
  });

  it('records what was captured on the audit trail, with the figure', async () => {
    let job = await workedJob(harness);
    job = await addAdditionalCharge(harness.context, job, {
      description: 'Workshop bench fee',
      amount: 60_000,
    });

    const events = await harness.repos.activity.list(job.id);
    const captured = events.find((event) => event.type === 'additional_charge_added');
    expect(captured).toBeDefined();
    expect(captured?.summary).toContain('600,00');
    expect(captured?.detail).toContain('Workshop bench fee');
  });
});

/**
 * DISCOUNTS WERE WITHDRAWN on 27 October 2026 (DISCOUNT-OFF-1). There is no
 * operation to apply or clear one. A job that ALREADY carries a discount — set
 * before the withdrawal — must keep exactly the totals it had, because those
 * totals may be on a document a customer signed.
 */
const withHistoricalDiscount = async (harness: Harness, job: Job, amount: number, reason: string): Promise<Job> =>
  harness.repos.jobs.save({
    ...job,
    discount: { amount, reason, authorisedBy: master.id, authorisedAt: '2026-10-20T09:00:00.000Z' } as Job['discount'],
  });

describe('a discount recorded before discounts were withdrawn', () => {
  it('still comes off the subtotal BEFORE VAT, exactly as it did', async () => {
    const harness = build(master);
    const job = await withHistoricalDiscount(harness, await workedJob(harness), 10_000, 'Agreed before 27 October');
    const totals = await totalsOf(harness, job);
    expect(totals.discountTotal).toBe(10_000);
    expect(totals.subtotal).toBe(totals.grossSubtotal - 10_000);
    expect(totals.vat).toBe(Math.round((totals.subtotal * totals.pricing.vatPercentage) / 100));
  });

  it('is still capped at the work when a line is removed afterwards', async () => {
    const harness = build(master);
    const job = await withHistoricalDiscount(harness, await workedJob(harness), 999_999_00, 'Legacy');
    const totals = await totalsOf(harness, job);
    expect(totals.discountTotal).toBe(totals.grossSubtotal);
    expect(totals.discountCapped).toBe(true);
  });
});

describe('what the customer signed for, written down', () => {
  it('carries the charge and a historical discount into the pricing snapshot', async () => {
    /*
     * The snapshot is the write-once answer to "what did the customer actually
     * sign for?", and a discount is the single figure most likely to be
     * queried. It has to be IN there — not recomputed later from a job that a
     * Master may legitimately have amended since.
     */
    const harness = build(master);
    let job = await workedJob(harness);
    job = await addAdditionalCharge(harness.context, job, {
      description: 'Workshop consumables',
      amount: 30_000,
    });
    // A discount recorded before the withdrawal: history the snapshot must keep.
    job = await withHistoricalDiscount(harness, job, 20_000, 'Goodwill on a repeat visit');

    const settings = await settingsOf(harness);
    const totals = calculateJobTotals(job, settings);
    const snapshot = {
      labourRates: settings.labourRates,
      calloutRate: settings.calloutRate,
      kilometreRate: settings.kilometreRate,
      vatPercentage: settings.vatPercentage,
      capturedAt: '2026-10-22T09:00:00.000Z',
      reason: 'customer_signature' as const,
    };
    const materialised = materialisePricingSnapshot(job, snapshot);

    const charge = materialised.lines.find((line) => line.kind === 'additional_charge');
    expect(charge?.detail).toBe('Workshop consumables');
    expect(charge?.lineTotal).toBe(30_000);

    const discount = materialised.lines.find((line) => line.kind === 'discount');
    expect(discount).toBeDefined();
    // NEGATIVE, so anything summing the lines gets the subtotal the customer
    // signed rather than that figure plus twice the discount.
    expect(discount?.lineTotal).toBe(-20_000);
    expect(discount?.detail).toBe('Goodwill on a repeat visit');

    expect(materialised.totals.grossSubtotal).toBe(totals.grossSubtotal);
    expect(materialised.totals.discount).toBe(20_000);
    expect(materialised.totals.subtotal).toBe(totals.grossSubtotal - 20_000);

    // The lines add up to the subtotal. The assertion the negative sign is for.
    const summed = materialised.lines.reduce((acc, line) => acc + line.lineTotal, 0);
    expect(summed).toBe(materialised.totals.subtotal);
  });
});
