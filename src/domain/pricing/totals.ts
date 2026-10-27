import type { Cents } from '../types/common';
import type { Job, LabourRateType, PricingSnapshot } from '../types/job';
import type { PricingInputs, SystemSettings } from '../types/settings';

/**
 * Job costing.
 *
 * All arithmetic is in integer cents. Hours and kilometres are decimal, so each
 * line total is rounded once, at the line, using round-half-up — the same rule
 * the invoice will use in production.
 */

const roundCents = (value: number): Cents => Math.round(value + Number.EPSILON);

export interface CostLine {
  readonly label: string;
  readonly detail: string;
  readonly quantity: number;
  readonly unit: string;
  readonly unitPrice: Cents;
  readonly total: Cents;
}

export interface JobTotals {
  /** The rates these figures were produced with. */
  readonly pricing: PricingInputs;
  /** True when the figures come from a snapshot rather than current settings. */
  readonly priceFrozen: boolean;
  readonly labourLines: readonly CostLine[];
  readonly calloutLines: readonly CostLine[];
  /** The test bench fee, once, where it is ticked. BENCH-1. */
  readonly testBenchLines: readonly CostLine[];
  readonly travelLines: readonly CostLine[];
  readonly partLines: readonly CostLine[];
  /** COST-5. One line per charge that is not labour, travel or a part. */
  readonly additionalChargeLines: readonly CostLine[];
  readonly labourTotal: Cents;
  readonly calloutTotal: Cents;
  readonly testBenchTotal: Cents;
  readonly travelTotal: Cents;
  readonly partsTotal: Cents;
  readonly additionalChargesTotal: Cents;
  /**
   * What the work comes to BEFORE a discount. COST-5.
   *
   * Named rather than left implicit because it is what a discount is measured
   * against, and because the document prints both: the office is asked "what
   * was it before you came down", and the answer has to be on the paper.
   */
  readonly grossSubtotal: Cents;
  /**
   * The discount actually taken off, which is NOT always what was recorded.
   *
   * A discount is agreed against the job as it stood. If a line is removed
   * afterwards the recorded amount can exceed what is left, and an invoice for
   * a negative sum is not a thing EJE can issue — so it is capped at the gross
   * subtotal here and `discountCapped` says so. The recorded figure is never
   * rewritten: the job still says what was agreed.
   */
  readonly discountTotal: Cents;
  readonly discountCapped: boolean;
  /** The discount as RECORDED, before any capping. */
  readonly discountRecorded: Cents;
  /** `grossSubtotal` less `discountTotal`. What VAT is charged on. */
  readonly subtotal: Cents;
  readonly vat: Cents;
  readonly total: Cents;
  readonly totalHours: number;
  readonly totalKilometres: number;
}

/** Copies the pricing-relevant values out of the current system settings. */
export const pricingInputsFrom = (settings: SystemSettings): PricingInputs => ({
  labourRates: { ...settings.labourRates },
  calloutRate: settings.calloutRate,
  testBenchFee: settings.testBenchFee,
  kilometreRate: settings.kilometreRate,
  vatPercentage: settings.vatPercentage,
});

/**
 * The rates a job is actually priced at.
 *
 * A job that carries a snapshot is priced at the snapshot, always and only. Any
 * other job is priced at current settings. This single function is why a rate
 * change cannot reach a signed job card.
 */
export const resolveJobPricing = (
  job: Pick<Job, 'pricingSnapshot'>,
  settings: SystemSettings,
): PricingInputs => job.pricingSnapshot ?? pricingInputsFrom(settings);

/** True when this job's figures are frozen rather than following current rates. */
export const isPricingFrozen = (
  job: Pick<Job, 'pricingSnapshot'>,
): job is { pricingSnapshot: PricingSnapshot } => job.pricingSnapshot !== null;

export const labourRateFor = (pricing: PricingInputs, rateType: LabourRateType): Cents => {
  switch (rateType) {
    case 'normal':
      return pricing.labourRates.normal;
    case 'overtime':
      return pricing.labourRates.overtime;
    case 'double':
      return pricing.labourRates.double;
  }
};

export const labourRateLabel = (rateType: LabourRateType): string => {
  switch (rateType) {
    case 'normal':
      return 'Normal Time';
    case 'overtime':
      return 'Overtime';
    case 'double':
      return 'Double Time';
  }
};

/** The cost-bearing parts of a job: everything `calculateJobTotals` reads. */
export type CostedJob = Pick<
  Job,
  | 'labour'
  | 'travel'
  | 'parts'
  | 'additionalCharges'
  | 'discount'
  | 'calloutApplied'
  | 'pricingSnapshot'
> &
  Partial<Pick<Job, 'testBenchApplied'>>;

export const calculateJobTotals = (job: CostedJob, settings: SystemSettings): JobTotals => {
  // A signed job prices at its snapshot; everything else prices at current rates.
  const pricing = resolveJobPricing(job, settings);

  const labourLines: CostLine[] = job.labour.map((entry) => {
    const unitPrice = labourRateFor(pricing, entry.rateType);
    return {
      label: labourRateLabel(entry.rateType),
      detail: entry.description,
      quantity: entry.hours,
      unit: 'hrs',
      unitPrice,
      total: roundCents(entry.hours * unitPrice),
    };
  });

  const calloutLines: CostLine[] = job.calloutApplied
    ? [
        {
          label: 'Call-out',
          detail: 'Fixed call-out fee',
          quantity: 1,
          unit: 'ea',
          unitPrice: pricing.calloutRate,
          total: pricing.calloutRate,
        },
      ]
    : [];

  /*
   * BENCH-1. Once per job, from the rates in force — or, on a signed job, from
   * its snapshot. A snapshot taken before the fee existed has no figure, and
   * no job signed then carried the fee, so it reads as nothing.
   */
  const benchFee = pricing.testBenchFee ?? 0;
  const testBenchLines: CostLine[] = job.testBenchApplied === true
    ? [
        {
          label: 'Test bench fee',
          detail: 'Fixed test bench fee',
          quantity: 1,
          unit: 'ea',
          unitPrice: benchFee,
          total: benchFee,
        },
      ]
    : [];

  const travelLines: CostLine[] = job.travel.map((entry) => ({
    label: 'Travel',
    detail: entry.description,
    quantity: entry.kilometres,
    unit: 'km',
    unitPrice: pricing.kilometreRate,
    total: roundCents(entry.kilometres * pricing.kilometreRate),
  }));

  const partLines: CostLine[] = job.parts.map((entry) => ({
    label: entry.partNumber,
    detail: entry.description,
    quantity: entry.quantity,
    unit: 'ea',
    // Part prices are captured on the line itself, so they are already
    // historical and are never re-priced from settings.
    unitPrice: entry.unitPrice,
    total: roundCents(entry.quantity * entry.unitPrice),
  }));

  /*
   * COST-5. Priced on the line, like a part: there is no rate in settings for
   * "consumables", so the amount is historical the moment it is written and no
   * rate change can reach it. One unit, because a sum of money with a reason
   * next to it has no quantity — see `AdditionalChargeEntry`.
   */
  const additionalChargeLines: CostLine[] = job.additionalCharges.map((entry) => ({
    label: 'Additional charge',
    detail: entry.description,
    quantity: 1,
    unit: 'ea',
    unitPrice: entry.amount,
    total: entry.amount,
  }));

  const sum = (lines: readonly CostLine[]): Cents =>
    lines.reduce((acc, line) => acc + line.total, 0);

  const labourTotal = sum(labourLines);
  const calloutTotal = sum(calloutLines);
  const testBenchTotal = sum(testBenchLines);
  const travelTotal = sum(travelLines);
  const partsTotal = sum(partLines);
  const additionalChargesTotal = sum(additionalChargeLines);
  const grossSubtotal =
    labourTotal + calloutTotal + testBenchTotal + travelTotal + partsTotal + additionalChargesTotal;

  /*
   * THE DISCOUNT, CAPPED AT THE WORK. COST-5.
   *
   * The write path refuses a discount larger than the job, but a line removed
   * AFTERWARDS can leave one stranded above what is left, and an invoice for a
   * negative sum is not something EJE can issue. The recorded figure is left
   * alone — the job still says what was agreed — and the capping is reported so
   * a screen can say the discount now covers the whole job rather than silently
   * showing a smaller number than the one on the record.
   */
  const discountRecorded = job.discount?.amount ?? 0;
  const discountTotal = Math.min(discountRecorded, grossSubtotal);
  const subtotal = grossSubtotal - discountTotal;
  const vat = roundCents((subtotal * pricing.vatPercentage) / 100);

  return {
    pricing,
    priceFrozen: job.pricingSnapshot !== null,
    labourLines,
    calloutLines,
    testBenchLines,
    travelLines,
    partLines,
    additionalChargeLines,
    labourTotal,
    calloutTotal,
    testBenchTotal,
    travelTotal,
    partsTotal,
    additionalChargesTotal,
    grossSubtotal,
    discountTotal,
    discountCapped: discountTotal < discountRecorded,
    discountRecorded,
    subtotal,
    vat,
    total: subtotal + vat,
    totalHours: job.labour.reduce((acc, entry) => acc + entry.hours, 0),
    totalKilometres: job.travel.reduce((acc, entry) => acc + entry.kilometres, 0),
  };
};
