import { describe, expect, it } from 'vitest';
import { calculateJobTotals, isPricingFrozen, pricingInputsFrom } from './totals';
import { asLineItemId, asUserId } from '../types/common';
import type { Job, PricingSnapshot } from '../types/job';
import type { SystemSettings } from '../types/settings';

/**
 * Historical pricing.
 *
 * A signed job card is a commercial document. Once the customer has signed for a
 * figure, changing a rate in the system must never alter that figure. These tests
 * walk the exact sequence: price at rate A, freeze, move the system to rate B,
 * then confirm the old job is untouched and a new job picks up rate B.
 */

const technicianId = asUserId('user-tech-1');

const RATES_A: SystemSettings = {
  companyName: 'EJE Industrial Electronics',
  companyRegistration: '2004/018273/07',
  companyVatNumber: '4180276351',
  companyPhone: '+27 11 555 0100',
  companyEmail: 'service@eje-demo.co.za',
  companyAddress: '14 Anvil Road, Isando, Kempton Park, 1600',
  labourRates: { normal: 95000, overtime: 142500, double: 190000 },
  calloutRate: 85000,
  kilometreRate: 1850,
  vatPercentage: 15,
  jobNumberPrefix: 'EJE-',
  nextJobSequence: 1060,
  quietHoursStart: '18:00',
  quietHoursEnd: '07:00',
};

/** Every pricing input moved, including VAT and the call-out fee. */
const RATES_B: SystemSettings = {
  ...RATES_A,
  labourRates: { normal: 120000, overtime: 180000, double: 240000 },
  calloutRate: 110000,
  kilometreRate: 2500,
  vatPercentage: 18,
};

const workedJob = (overrides: Partial<Job> = {}) =>
  ({
    labour: [
      {
        id: asLineItemId('l1'),
        technicianId,
        date: '2026-09-15',
        rateType: 'normal' as const,
        hours: 4,
        description: 'Spindle drive repair',
        capturedAt: '2026-09-15T09:00:00.000Z',
        capturedBy: technicianId,
      },
      {
        id: asLineItemId('l2'),
        technicianId,
        date: '2026-09-15',
        rateType: 'overtime' as const,
        hours: 2,
        description: 'After-hours completion',
        capturedAt: '2026-09-15T18:00:00.000Z',
        capturedBy: technicianId,
      },
    ],
    travel: [
      {
        id: asLineItemId('t1'),
        technicianId,
        date: '2026-09-15',
        kilometres: 48,
        description: 'Isando to site and return',
        capturedAt: '2026-09-15T08:00:00.000Z',
        capturedBy: technicianId,
      },
    ],
    parts: [
      {
        id: asLineItemId('p1'),
        partNumber: 'FAN-24V-80',
        description: 'Spindle drive cooling fan',
        quantity: 1,
        unitPrice: 48500,
        capturedAt: '2026-09-15T13:00:00.000Z',
        capturedBy: technicianId,
      },
    ],
    calloutApplied: true,
    pricingSnapshot: null,
    ...overrides,
  }) satisfies Pick<
    Job,
    'labour' | 'travel' | 'parts' | 'calloutApplied' | 'pricingSnapshot'
  >;

const freeze = (settings: SystemSettings): PricingSnapshot => ({
  ...pricingInputsFrom(settings),
  capturedAt: '2026-09-15T15:30:00.000Z',
  reason: 'customer_signature',
});

describe('a job signed at rate A is never re-priced by a later rate change', () => {
  // The figure the customer signed for, calculated at rate A.
  const openJob = workedJob();
  const totalsAtSignature = calculateJobTotals(openJob, RATES_A);

  const signedJob = workedJob({ pricingSnapshot: freeze(RATES_A) });

  it('prices the open job at current settings before it is frozen', () => {
    // labour 4 x 950.00 + 2 x 1425.00, call-out 850.00, travel 48 x 18.50,
    // parts 485.00 → subtotal, then 15% VAT.
    expect(totalsAtSignature.labourTotal).toBe(380000 + 285000);
    expect(totalsAtSignature.calloutTotal).toBe(85000);
    expect(totalsAtSignature.travelTotal).toBe(88800);
    expect(totalsAtSignature.partsTotal).toBe(48500);
    expect(totalsAtSignature.subtotal).toBe(887300);
    expect(totalsAtSignature.vat).toBe(133095);
    expect(totalsAtSignature.total).toBe(1020395);
    expect(totalsAtSignature.priceFrozen).toBe(false);
  });

  it('reproduces exactly the same figures after every system rate has changed', () => {
    const afterRateChange = calculateJobTotals(signedJob, RATES_B);

    expect(afterRateChange.total).toBe(totalsAtSignature.total);
    expect(afterRateChange.subtotal).toBe(totalsAtSignature.subtotal);
    expect(afterRateChange.vat).toBe(totalsAtSignature.vat);
    expect(afterRateChange.labourTotal).toBe(totalsAtSignature.labourTotal);
    expect(afterRateChange.calloutTotal).toBe(totalsAtSignature.calloutTotal);
    expect(afterRateChange.travelTotal).toBe(totalsAtSignature.travelTotal);
    expect(afterRateChange.partsTotal).toBe(totalsAtSignature.partsTotal);
  });

  it('holds each individual rate against the snapshot, not current settings', () => {
    const afterRateChange = calculateJobTotals(signedJob, RATES_B);

    expect(afterRateChange.pricing.labourRates.normal).toBe(95000);
    expect(afterRateChange.pricing.labourRates.overtime).toBe(142500);
    expect(afterRateChange.pricing.labourRates.double).toBe(190000);
    expect(afterRateChange.pricing.calloutRate).toBe(85000);
    expect(afterRateChange.pricing.kilometreRate).toBe(1850);
    expect(afterRateChange.pricing.vatPercentage).toBe(15);
    expect(afterRateChange.priceFrozen).toBe(true);
  });

  it('reports the individual line unit prices from the snapshot', () => {
    const afterRateChange = calculateJobTotals(signedJob, RATES_B);
    expect(afterRateChange.labourLines[0]?.unitPrice).toBe(95000);
    expect(afterRateChange.labourLines[1]?.unitPrice).toBe(142500);
    expect(afterRateChange.travelLines[0]?.unitPrice).toBe(1850);
    expect(afterRateChange.calloutLines[0]?.unitPrice).toBe(85000);
  });

  it('prices a NEW job at the new rates', () => {
    const newJob = workedJob();
    const newTotals = calculateJobTotals(newJob, RATES_B);

    expect(newTotals.labourTotal).toBe(480000 + 360000);
    expect(newTotals.calloutTotal).toBe(110000);
    expect(newTotals.travelTotal).toBe(120000);
    expect(newTotals.pricing.vatPercentage).toBe(18);
    expect(newTotals.total).toBeGreaterThan(totalsAtSignature.total);
    expect(newTotals.priceFrozen).toBe(false);
  });
});

describe('snapshot completeness', () => {
  it('copies values rather than sharing structure with the settings record', () => {
    const snapshot = pricingInputsFrom(RATES_A);

    // The nested rate object must be a distinct copy, otherwise a later edit to
    // the settings record would reach through into every stored snapshot.
    expect(snapshot.labourRates).not.toBe(RATES_A.labourRates);
    expect(snapshot.labourRates).toEqual(RATES_A.labourRates);

    // And the snapshot holds values, not a pointer back to the settings record.
    expect(Object.values(snapshot)).not.toContain(RATES_A);
  });

  it('carries every pricing input needed to reproduce the calculation', () => {
    const snapshot = pricingInputsFrom(RATES_A);
    expect(Object.keys(snapshot).sort()).toEqual([
      'calloutRate',
      'kilometreRate',
      'labourRates',
      'vatPercentage',
    ]);
    expect(Object.keys(snapshot.labourRates).sort()).toEqual([
      'double',
      'normal',
      'overtime',
    ]);
  });

  it('identifies frozen and unfrozen jobs', () => {
    expect(isPricingFrozen({ pricingSnapshot: null })).toBe(false);
    expect(isPricingFrozen({ pricingSnapshot: freeze(RATES_A) })).toBe(true);
  });
});

describe('call-out fee', () => {
  it('is charged once when applied, and not at all when not', () => {
    const withCallout = calculateJobTotals(workedJob({ calloutApplied: true }), RATES_A);
    const withoutCallout = calculateJobTotals(workedJob({ calloutApplied: false }), RATES_A);

    expect(withCallout.calloutLines).toHaveLength(1);
    expect(withoutCallout.calloutLines).toHaveLength(0);
    expect(withCallout.calloutTotal - withoutCallout.calloutTotal).toBe(85000);
  });
});
