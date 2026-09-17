import { describe, expect, it } from 'vitest';
import { buildPartsDocument, showsPricesOnCollectionDocument } from './parts-document';
import { asLineItemId } from '../types/common';
import type { PartEntry } from '../types/job';

/**
 * Courier collection.
 *
 * A courier has no reason to see what the customer paid, so the collection
 * document withholds prices. The prices themselves must survive on the job for
 * EJE costing — withheld, never deleted.
 */
const parts: PartEntry[] = [
  {
    id: asLineItemId('p1'),
    partNumber: 'FAN-24V-80',
    description: 'Spindle drive cooling fan',
    quantity: 2,
    unitPrice: 48500,
    capturedAt: '2026-09-17T10:00:00.000Z',
  },
  {
    id: asLineItemId('p2'),
    partNumber: 'BAT-3V-FAN',
    description: 'Control memory battery',
    quantity: 3,
    unitPrice: 42000,
    capturedAt: '2026-09-17T10:05:00.000Z',
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

  it('HIDES prices when a courier collects', () => {
    expect(showsPricesOnCollectionDocument(partsJob(true))).toBe(false);
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

describe('buildPartsDocument for a courier collection', () => {
  const document = buildPartsDocument(partsJob(true));

  it('still lists every part, with quantities', () => {
    expect(document.lines).toHaveLength(2);
    expect(document.lines[0]?.partNumber).toBe('FAN-24V-80');
    expect(document.lines[0]?.quantity).toBe(2);
    expect(document.totalQuantity).toBe(5);
  });

  it('withholds every unit price and line total', () => {
    expect(document.showsPrices).toBe(false);
    for (const line of document.lines) {
      expect(line.unitPrice).toBeNull();
      expect(line.lineTotal).toBeNull();
    }
  });

  it('withholds the document total', () => {
    expect(document.subtotal).toBeNull();
  });

  it('leaves the underlying price data on the job untouched', () => {
    const job = partsJob(true);
    buildPartsDocument(job);

    expect(job.parts[0]?.unitPrice).toBe(48500);
    expect(job.parts[1]?.unitPrice).toBe(42000);
  });

  it('emits no price anywhere in the serialised document', () => {
    const serialised = JSON.stringify(buildPartsDocument(partsJob(true)));
    expect(serialised).not.toContain('48500');
    expect(serialised).not.toContain('42000');
  });
});
