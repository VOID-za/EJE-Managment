import { describe, expect, it } from 'vitest';
import { calculateJobTotals } from './totals';
import { asLineItemId, asUserId } from '../types/common';
import type { SystemSettings } from '../types/settings';

const settings: SystemSettings = {
  companyName: 'EJE Industrial Electronics',
  companyRegistration: '2004/012345/07',
  companyVatNumber: '4123456789',
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

const technicianId = asUserId('user-tech-1');

describe('calculateJobTotals', () => {
  it('returns zeroes for a job with no captured work', () => {
    const totals = calculateJobTotals({ labour: [], travel: [], parts: [], calloutApplied: false, pricingSnapshot: null }, settings);
    expect(totals.subtotal).toBe(0);
    expect(totals.vat).toBe(0);
    expect(totals.total).toBe(0);
  });

  it('prices labour by rate type', () => {
    const totals = calculateJobTotals(
      {
        labour: [
          {
            id: asLineItemId('l1'),
            technicianId,
            date: '2026-09-15',
            rateType: 'normal',
            hours: 2,
            description: 'Diagnostics',
            capturedAt: '2026-09-15T08:00:00.000Z',
          },
          {
            id: asLineItemId('l2'),
            technicianId,
            date: '2026-09-15',
            rateType: 'overtime',
            hours: 1.5,
            description: 'After-hours repair',
            capturedAt: '2026-09-15T18:00:00.000Z',
          },
        ],
        travel: [],
        parts: [],
        calloutApplied: false,
        pricingSnapshot: null,
      },
      settings,
    );

    // 2 x R950.00 = R1 900.00, 1.5 x R1 425.00 = R2 137.50
    expect(totals.labourTotal).toBe(190000 + 213750);
    expect(totals.totalHours).toBe(3.5);
  });

  it('applies VAT to the combined subtotal', () => {
    const totals = calculateJobTotals(
      {
        labour: [],
        travel: [
          {
            id: asLineItemId('t1'),
            technicianId,
            date: '2026-09-15',
            kilometres: 40,
            description: 'Isando to Germiston return',
            capturedAt: '2026-09-15T07:00:00.000Z',
          },
        ],
        parts: [
          {
            id: asLineItemId('p1'),
            partNumber: 'FAN-24V-80',
            description: 'Cabinet cooling fan',
            quantity: 2,
            unitPrice: 48500,
            capturedAt: '2026-09-15T10:00:00.000Z',
          },
        ],
        calloutApplied: false,
        pricingSnapshot: null,
      },
      settings,
    );

    expect(totals.travelTotal).toBe(74000);
    expect(totals.partsTotal).toBe(97000);
    expect(totals.subtotal).toBe(171000);
    expect(totals.vat).toBe(25650);
    expect(totals.total).toBe(196650);
  });

  it('rounds each line once rather than accumulating float error', () => {
    const totals = calculateJobTotals(
      {
        labour: [
          {
            id: asLineItemId('l1'),
            technicianId,
            date: '2026-09-15',
            rateType: 'normal',
            hours: 0.33,
            description: 'Call-out assessment',
            capturedAt: '2026-09-15T08:00:00.000Z',
          },
        ],
        travel: [],
        parts: [],
        calloutApplied: false,
        pricingSnapshot: null,
      },
      settings,
    );

    // 0.33 x 95000 = 31350 exactly, no residual fraction of a cent.
    expect(totals.labourTotal).toBe(31350);
    expect(Number.isInteger(totals.total)).toBe(true);
  });
});
