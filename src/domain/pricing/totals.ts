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
  readonly travelLines: readonly CostLine[];
  readonly partLines: readonly CostLine[];
  readonly labourTotal: Cents;
  readonly calloutTotal: Cents;
  readonly travelTotal: Cents;
  readonly partsTotal: Cents;
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

export const calculateJobTotals = (
  job: Pick<Job, 'labour' | 'travel' | 'parts' | 'calloutApplied' | 'pricingSnapshot'>,
  settings: SystemSettings,
): JobTotals => {
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

  const sum = (lines: readonly CostLine[]): Cents =>
    lines.reduce((acc, line) => acc + line.total, 0);

  const labourTotal = sum(labourLines);
  const calloutTotal = sum(calloutLines);
  const travelTotal = sum(travelLines);
  const partsTotal = sum(partLines);
  const subtotal = labourTotal + calloutTotal + travelTotal + partsTotal;
  const vat = roundCents((subtotal * pricing.vatPercentage) / 100);

  return {
    pricing,
    priceFrozen: job.pricingSnapshot !== null,
    labourLines,
    calloutLines,
    travelLines,
    partLines,
    labourTotal,
    calloutTotal,
    travelTotal,
    partsTotal,
    subtotal,
    vat,
    total: subtotal + vat,
    totalHours: job.labour.reduce((acc, entry) => acc + entry.hours, 0),
    totalKilometres: job.travel.reduce((acc, entry) => acc + entry.kilometres, 0),
  };
};
