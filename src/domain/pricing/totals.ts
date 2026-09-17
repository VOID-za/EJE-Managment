import type { Cents } from '../types/common';
import type { Job, LabourRateType } from '../types/job';
import type { SystemSettings } from '../types/settings';

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
  readonly labourLines: readonly CostLine[];
  readonly travelLines: readonly CostLine[];
  readonly partLines: readonly CostLine[];
  readonly labourTotal: Cents;
  readonly travelTotal: Cents;
  readonly partsTotal: Cents;
  readonly subtotal: Cents;
  readonly vat: Cents;
  readonly total: Cents;
  readonly totalHours: number;
  readonly totalKilometres: number;
}

export const labourRateFor = (settings: SystemSettings, rateType: LabourRateType): Cents => {
  switch (rateType) {
    case 'normal':
      return settings.labourRates.normal;
    case 'overtime':
      return settings.labourRates.overtime;
    case 'double':
      return settings.labourRates.double;
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
  job: Pick<Job, 'labour' | 'travel' | 'parts'>,
  settings: SystemSettings,
): JobTotals => {
  const labourLines: CostLine[] = job.labour.map((entry) => {
    const unitPrice = labourRateFor(settings, entry.rateType);
    return {
      label: labourRateLabel(entry.rateType),
      detail: entry.description,
      quantity: entry.hours,
      unit: 'hrs',
      unitPrice,
      total: roundCents(entry.hours * unitPrice),
    };
  });

  const travelLines: CostLine[] = job.travel.map((entry) => ({
    label: 'Travel',
    detail: entry.description,
    quantity: entry.kilometres,
    unit: 'km',
    unitPrice: settings.kilometreRate,
    total: roundCents(entry.kilometres * settings.kilometreRate),
  }));

  const partLines: CostLine[] = job.parts.map((entry) => ({
    label: entry.partNumber,
    detail: entry.description,
    quantity: entry.quantity,
    unit: 'ea',
    unitPrice: entry.unitPrice,
    total: roundCents(entry.quantity * entry.unitPrice),
  }));

  const sum = (lines: readonly CostLine[]): Cents =>
    lines.reduce((acc, line) => acc + line.total, 0);

  const labourTotal = sum(labourLines);
  const travelTotal = sum(travelLines);
  const partsTotal = sum(partLines);
  const subtotal = labourTotal + travelTotal + partsTotal;
  const vat = roundCents((subtotal * settings.vatPercentage) / 100);

  return {
    labourLines,
    travelLines,
    partLines,
    labourTotal,
    travelTotal,
    partsTotal,
    subtotal,
    vat,
    total: subtotal + vat,
    totalHours: job.labour.reduce((acc, entry) => acc + entry.hours, 0),
    totalKilometres: job.travel.reduce((acc, entry) => acc + entry.kilometres, 0),
  };
};
