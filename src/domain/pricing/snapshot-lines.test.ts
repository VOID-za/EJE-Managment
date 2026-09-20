import { describe, expect, it } from 'vitest';
import type { Job, PricingSnapshot } from '../types/job';
import { materialisePricingSnapshot } from './snapshot-lines';

/**
 * Writing down what the customer signed for.
 *
 * The snapshot freezes the RATES, and totals are normally recomputed from the
 * job's current lines using them. That is correct only while the job cannot
 * change — and a Master may legitimately amend a job after the customer signed
 * but before it is issued, which `master_amended_after_signature` exists
 * because of. Once they do, "what did the customer put their name to?" has no
 * answer left anywhere unless the lines themselves were written down.
 *
 * This is the projection that writes them. It calculates nothing of its own: it
 * labels and orders what `calculateJobTotals` already worked out, so the
 * persistence layer never has to.
 */

const SNAPSHOT: PricingSnapshot = {
  labourRates: { normal: 95_000, overtime: 142_500, double: 190_000 },
  calloutRate: 85_000,
  kilometreRate: 1_850,
  vatPercentage: 15,
  capturedAt: '2026-09-20T15:00:00.000Z',
  reason: 'customer_signature',
};

type Priceable = Pick<Job, 'labour' | 'travel' | 'parts' | 'calloutApplied' | 'pricingSnapshot'>;

const priceable = (over: Partial<Priceable> = {}): Priceable => ({
  labour: [
    {
      id: 'lab-1',
      technicianId: 'user-tech-sipho',
      date: '2026-09-20',
      rateType: 'normal',
      hours: 2,
      description: 'Spindle drive repair',
      capturedAt: '2026-09-20T10:00:00.000Z',
      capturedBy: 'user-tech-sipho',
    },
  ],
  travel: [
    {
      id: 'trv-1',
      technicianId: 'user-tech-sipho',
      date: '2026-09-20',
      kilometres: 60,
      description: 'Isando and back',
      capturedAt: '2026-09-20T10:00:00.000Z',
      capturedBy: 'user-tech-sipho',
    },
  ],
  parts: [
    {
      id: 'prt-1',
      partNumber: 'FAN-24V-120',
      description: 'Cooling fan',
      quantity: 1,
      unitPrice: 128_000,
      capturedAt: '2026-09-20T10:00:00.000Z',
      capturedBy: 'user-tech-sipho',
    },
  ],
  calloutApplied: true,
  pricingSnapshot: null,
  ...over,
}) as Priceable;

describe('materialising a pricing snapshot', () => {
  it('writes the lines in the order the document prints them', () => {
    const { lines } = materialisePricingSnapshot(priceable(), SNAPSHOT);
    expect(lines.map((line) => line.kind)).toEqual(['labour', 'callout', 'travel', 'part']);
    expect(lines.map((line) => line.position)).toEqual([0, 1, 2, 3]);
  });

  it('points each line at the job line it was priced from', () => {
    const { lines } = materialisePricingSnapshot(priceable(), SNAPSHOT);
    expect(lines[0]?.sourceLineId).toBe('lab-1');
    // The call-out has no line behind it; it is a charge, not a capture.
    expect(lines[1]?.sourceLineId).toBeNull();
    expect(lines[2]?.sourceLineId).toBe('trv-1');
    expect(lines[3]?.sourceLineId).toBe('prt-1');
  });

  it('carries the money as exact cents, and the totals with it', () => {
    const { lines, totals } = materialisePricingSnapshot(priceable(), SNAPSHOT);

    expect(lines[0]?.unitPrice).toBe(95_000);
    expect(lines[0]?.lineTotal).toBe(190_000);
    expect(lines[1]?.lineTotal).toBe(85_000);
    expect(lines[2]?.lineTotal).toBe(60 * 1_850);
    expect(lines[3]?.lineTotal).toBe(128_000);

    const subtotal = 190_000 + 85_000 + 60 * 1_850 + 128_000;
    expect(totals.subtotal).toBe(subtotal);
    expect(totals.vat).toBe(Math.round(subtotal * 0.15));
    expect(totals.total).toBe(subtotal + Math.round(subtotal * 0.15));
  });

  it('prices at the SNAPSHOT’s rates, not at today’s', () => {
    // The same job, frozen when labour was cheaper.
    const older: PricingSnapshot = {
      ...SNAPSHOT,
      labourRates: { normal: 80_000, overtime: 120_000, double: 160_000 },
    };
    const { lines } = materialisePricingSnapshot(priceable(), older);
    expect(lines[0]?.unitPrice).toBe(80_000);
    expect(lines[0]?.lineTotal).toBe(160_000);
  });

  it('gives the same answer for a new snapshot and for a reread of a frozen job', () => {
    const freshlyFrozen = materialisePricingSnapshot(priceable(), SNAPSHOT);
    const reread = materialisePricingSnapshot(
      priceable({ pricingSnapshot: SNAPSHOT }),
      SNAPSHOT,
    );
    expect(reread).toEqual(freshlyFrozen);
  });

  it('leaves out a call-out that was not applied', () => {
    const { lines } = materialisePricingSnapshot(priceable({ calloutApplied: false }), SNAPSHOT);
    expect(lines.some((line) => line.kind === 'callout')).toBe(false);
    expect(lines.map((line) => line.position)).toEqual([0, 1, 2]);
  });

  it('produces nothing at all for a job with nothing on it', () => {
    const empty = materialisePricingSnapshot(
      priceable({ labour: [], travel: [], parts: [], calloutApplied: false }),
      SNAPSHOT,
    );
    expect(empty.lines).toEqual([]);
    expect(empty.totals).toEqual({ subtotal: 0, vat: 0, total: 0 });
  });

  it('labels every line so the document can be rebuilt from the record alone', () => {
    const { lines } = materialisePricingSnapshot(priceable(), SNAPSHOT);
    for (const line of lines) {
      expect(line.description.length).toBeGreaterThan(0);
      expect(line.unit.length).toBeGreaterThan(0);
    }
  });
});
