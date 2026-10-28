import { describe, expect, it } from 'vitest';
import { buildPartsDocument, requiresDeliveryNote, showsPricesOnCollectionDocument } from './parts-document';
import { asLineItemId, asUserId } from '../types/common';
import type { PartEntry } from '../types/job';

/**
 * Courier collection.
 *
 * A courier has no reason to see what the customer paid. Since PARTS-03/04
 * (the real-world reviewer, 28 October 2026) that is the DELIVERY NOTE's job —
 * a separate document with no prices (`src/lib/job-card/delivery-note.test.ts`)
 * — and the job card itself always carries its prices, because the office must
 * have a priced job card for every job, courier or not.
 */
const technicianId = asUserId('user-tech-1');

const parts: PartEntry[] = [
  {
    id: asLineItemId('p1'),
    partNumber: 'FAN-24V-80',
    description: 'Spindle drive cooling fan',
    quantity: 2,
    unitPrice: 48500,
    capturedAt: '2026-09-17T10:00:00.000Z',
    capturedBy: technicianId,
  },
  {
    id: asLineItemId('p2'),
    partNumber: 'BAT-3V-FAN',
    description: 'Control memory battery',
    quantity: 3,
    unitPrice: 42000,
    capturedAt: '2026-09-17T10:05:00.000Z',
    capturedBy: technicianId,
  },
];

const partsJob = (courierCollection: boolean) => ({
  jobType: 'parts' as const,
  courierCollection,
  parts,
});

describe('showsPricesOnCollectionDocument', () => {
  it('shows prices when the customer collects', () => {
    expect(showsPricesOnCollectionDocument(partsJob(false))).toBe(true);
  });

  it('KEEPS prices on the job card when a courier collects — the courier gets a delivery note instead', () => {
    expect(showsPricesOnCollectionDocument(partsJob(true))).toBe(true);
    expect(requiresDeliveryNote(partsJob(true))).toBe(true);
    expect(requiresDeliveryNote(partsJob(false))).toBe(false);
    expect(requiresDeliveryNote({ jobType: 'test_and_repair', courierCollection: true })).toBe(true);
    expect(requiresDeliveryNote({ jobType: 'breakdown', courierCollection: true })).toBe(false);
  });

  it('never suppresses prices on a normal job card', () => {
    expect(
      showsPricesOnCollectionDocument({ jobType: 'breakdown', courierCollection: true }),
    ).toBe(true);
  });
});

describe('buildPartsDocument for a customer collection', () => {
  const document = buildPartsDocument(partsJob(false));

  it('lists every part with quantity, unit price and line total', () => {
    expect(document.lines).toHaveLength(2);
    expect(document.lines[0]).toEqual({
      partNumber: 'FAN-24V-80',
      description: 'Spindle drive cooling fan',
      quantity: 2,
      unitPrice: 48500,
      lineTotal: 97000,
    });
  });

  it('totals the document', () => {
    expect(document.subtotal).toBe(97000 + 126000);
    expect(document.totalQuantity).toBe(5);
  });
});

describe('buildPartsDocument for a courier collection (the priced job card, PARTS-04)', () => {
  const document = buildPartsDocument(partsJob(true));

  it('still lists every part, with quantities', () => {
    expect(document.lines).toHaveLength(2);
    expect(document.lines[0]?.partNumber).toBe('FAN-24V-80');
    expect(document.lines[0]?.quantity).toBe(2);
    expect(document.totalQuantity).toBe(5);
  });

  it('carries every unit price, line total and the total — it is the office’s job card', () => {
    expect(document.showsPrices).toBe(true);
    expect(document.lines[0]).toMatchObject({ unitPrice: 48500, lineTotal: 97000 });
    expect(document.subtotal).toBe(97000 + 126000);
  });

  it('leaves the underlying price data on the job untouched', () => {
    const job = partsJob(true);
    buildPartsDocument(job);

    expect(job.parts[0]?.unitPrice).toBe(48500);
    expect(job.parts[1]?.unitPrice).toBe(42000);
  });
});
