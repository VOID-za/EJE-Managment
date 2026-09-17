import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptJob,
  addLabour,
  addTravel,
  captureSignature,
  saveCompletionReport,
  setCalloutApplied,
  startCompletion,
  startSignature,
  submitJob,
} from './job-operations';
import type { OperationContext } from './context';
import { createDemoRepositories } from '@/data/demo/repositories';
import { DemoStore } from '@/data/demo/demo-store';
import { SimulatedEmailService } from '@/services/simulated/email';
import { SimulatedOutbox } from '@/services/simulated/outbox';
import { SimulatedPdfService } from '@/services/simulated/pdf';
import { SimulatedStorageService } from '@/services/simulated/storage';
import { SequentialIdGenerator, SystemClock } from '@/services/simulated/system';
import { SimulatedWhatsAppService } from '@/services/simulated/whatsapp';
import { calculateJobTotals, type Job, type User } from '@/domain';
import { seedUsers } from '@/data/seed';
import type { RepositoryBundle } from '@/data/repositories';

/**
 * End-to-end historical-data behaviour, exercised through the real operations,
 * repositories and services rather than against the pricing function directly.
 *
 * This is the sequence the business cares about: a job is worked and signed at
 * one set of rates, the Master later changes the rates, and the signed job card
 * must still show exactly what the customer signed.
 */

const actor: User = seedUsers.find((user) => user.role === 'technician' && user.active)!;

const buildContext = (): { context: OperationContext; repos: RepositoryBundle } => {
  const store = new DemoStore();
  const repos = createDemoRepositories({ read: store.read, commit: store.commit });
  const clock = new SystemClock();
  const ids = new SequentialIdGenerator();
  const outbox = new SimulatedOutbox();

  return {
    repos,
    context: {
      repos,
      actor,
      services: {
        clock,
        ids,
        email: new SimulatedEmailService(outbox, clock, ids),
        whatsapp: new SimulatedWhatsAppService(outbox, clock, ids),
        pdf: new SimulatedPdfService(clock),
        storage: new SimulatedStorageService(),
      },
    },
  };
};

/** Drives a breakdown job from open through to signed, capturing real work. */
const workAndSign = async (context: OperationContext, jobNumber: string): Promise<Job> => {
  const opened = await context.repos.jobs.findByJobNumber(jobNumber);
  expect(opened).not.toBeNull();

  let job = await acceptJob(context, opened!);
  job = await setCalloutApplied(context, job, true);
  job = await addLabour(context, job, {
    date: '2026-09-17',
    rateType: 'normal',
    hours: 4,
    description: 'Spindle drive repair',
  });
  job = await addTravel(context, job, {
    date: '2026-09-17',
    kilometres: 48,
    description: 'Isando to site and return',
  });
  job = await saveCompletionReport(context, job, {
    ...job.completionReport,
    workPerformed: 'Replaced the spindle drive cooling fan and cleared the alarm.',
  });
  job = await startCompletion(context, job);
  job = await startSignature(context, job);
  return captureSignature(context, job, {
    customerName: 'Pieter',
    customerSurname: 'Nel',
    strokeData: 'M0,0 L1,1',
  });
};

describe('a signed job keeps the rates it was signed at', () => {
  let context: OperationContext;
  let repos: RepositoryBundle;

  beforeEach(() => {
    const built = buildContext();
    context = built.context;
    repos = built.repos;
  });

  it('freezes pricing when the customer signs, and survives a rate change', async () => {
    const rateA = await repos.settings.get();
    const signed = await workAndSign(context, 'EJE-1048');

    expect(signed.pricingSnapshot).not.toBeNull();
    expect(signed.pricingSnapshot?.reason).toBe('customer_signature');
    expect(signed.pricingSnapshot?.labourRates.normal).toBe(rateA.labourRates.normal);

    const totalsAtSignature = calculateJobTotals(signed, rateA);

    // Submit and close the job.
    const result = await submitJob(context, signed, 'customer@example-demo.co.za', 'Pieter Nel');
    expect(result.job.status).toBe('closed');
    expect(result.job.pricingSnapshot).toEqual(signed.pricingSnapshot);

    // The Master now raises every rate.
    const rateB = await repos.settings.save({
      ...rateA,
      labourRates: { normal: 150000, overtime: 225000, double: 300000 },
      calloutRate: 140000,
      kilometreRate: 3000,
      vatPercentage: 20,
    });

    // Re-read the historical job exactly as a screen would.
    const reopened = await repos.jobs.findByJobNumber('EJE-1048');
    expect(reopened).not.toBeNull();

    const historicalTotals = calculateJobTotals(reopened!, rateB);

    expect(historicalTotals.total).toBe(totalsAtSignature.total);
    expect(historicalTotals.subtotal).toBe(totalsAtSignature.subtotal);
    expect(historicalTotals.vat).toBe(totalsAtSignature.vat);
    expect(historicalTotals.labourTotal).toBe(totalsAtSignature.labourTotal);
    expect(historicalTotals.calloutTotal).toBe(totalsAtSignature.calloutTotal);
    expect(historicalTotals.travelTotal).toBe(totalsAtSignature.travelTotal);
    expect(historicalTotals.pricing.vatPercentage).toBe(rateA.vatPercentage);
    expect(historicalTotals.priceFrozen).toBe(true);
  });

  it('prices a different, unsigned job at the new rates', async () => {
    const rateA = await repos.settings.get();
    const signed = await workAndSign(context, 'EJE-1048');
    await submitJob(context, signed, 'customer@example-demo.co.za', 'Pieter Nel');

    await repos.settings.save({
      ...rateA,
      labourRates: { normal: 150000, overtime: 225000, double: 300000 },
      calloutRate: 140000,
      kilometreRate: 3000,
      vatPercentage: 20,
    });
    const rateB = await repos.settings.get();

    // EJE-1061 is seeded in progress and has never been signed.
    const openJob = await repos.jobs.findByJobNumber('EJE-1061');
    expect(openJob).not.toBeNull();
    expect(openJob!.pricingSnapshot).toBeNull();

    const totals = calculateJobTotals(openJob!, rateB);
    expect(totals.priceFrozen).toBe(false);
    expect(totals.pricing.labourRates.normal).toBe(150000);
    expect(totals.pricing.vatPercentage).toBe(20);
    // 2 hours at the new normal rate.
    expect(totals.labourTotal).toBe(300000);
  });

  it('does not overwrite a snapshot that already exists', async () => {
    const signed = await workAndSign(context, 'EJE-1048');
    const original = signed.pricingSnapshot;

    await repos.settings.save({
      ...(await repos.settings.get()),
      labourRates: { normal: 999999, overtime: 999999, double: 999999 },
    });

    const result = await submitJob(context, signed, 'customer@example-demo.co.za', 'Pieter Nel');
    expect(result.job.pricingSnapshot).toEqual(original);
  });
});
