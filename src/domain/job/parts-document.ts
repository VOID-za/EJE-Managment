import type { Cents } from '../types/common';
import type { Job } from '../types/job';
import { getJobTypeDefinition } from './job-types';
import type { TransitionCheck } from './workflow';

/**
 * Collection document rules.
 *
 * The rule that matters commercially is unchanged: a courier collecting on a
 * customer's behalf has no business seeing what the customer paid.
 *
 * WHAT CHANGED ON 28 OCTOBER 2026 (PARTS-03/04, the real-world reviewer): a
 * courier collection used to turn the JOB CARD itself into a price-less copy,
 * so the office had no priced job card for that job at all. Now there are TWO
 * documents. The job card always carries its prices — it is the office's
 * record and the customer's copy. The courier is given a separate DELIVERY
 * NOTE (`src/lib/job-card/delivery-note.ts`) that lists the goods and never a
 * price. Job cards issued before keep exactly the bytes they were issued with.
 *
 * Kept as a function so the one place that decides stays one place.
 */
export const showsPricesOnCollectionDocument = (
  _job: Pick<Job, 'jobType' | 'courierCollection'>,
): boolean => true;

/**
 * A courier is collecting, so a delivery note goes with the goods. PARTS-03.
 * Parts and workshop Test & Repair jobs — the two collected from the counter.
 */
export const requiresDeliveryNote = (job: Pick<Job, 'jobType' | 'courierCollection'>): boolean =>
  getJobTypeDefinition(job.jobType).collectedOnCompletion && job.courierCollection;

export interface PartsDocumentLine {
  readonly partNumber: string;
  readonly description: string;
  readonly quantity: number;
  /** Null when the document withholds prices. */
  readonly unitPrice: Cents | null;
  readonly lineTotal: Cents | null;
}

export interface PartsDocument {
  readonly lines: readonly PartsDocumentLine[];
  readonly showsPrices: boolean;
  readonly totalQuantity: number;
  /** Null when the document withholds prices. */
  readonly subtotal: Cents | null;
}

/**
 * Builds exactly what may appear on the collection document.
 *
 * Suppression happens here rather than in the view, so a price cannot leak onto
 * a courier's copy by a component forgetting to check a flag.
 */
export const buildPartsDocument = (
  job: Pick<Job, 'jobType' | 'courierCollection' | 'parts'>,
): PartsDocument => {
  const showsPrices = showsPricesOnCollectionDocument(job);

  const lines = job.parts.map<PartsDocumentLine>((part) => ({
    partNumber: part.partNumber,
    description: part.description,
    quantity: part.quantity,
    unitPrice: showsPrices ? part.unitPrice : null,
    lineTotal: showsPrices ? part.quantity * part.unitPrice : null,
  }));

  return {
    lines,
    showsPrices,
    totalQuantity: job.parts.reduce((total, part) => total + part.quantity, 0),
    subtotal: showsPrices
      ? job.parts.reduce((total, part) => total + part.quantity * part.unitPrice, 0)
      : null,
  };
};

/**
 * A courier collection needs a waybill; a customer collection does not.
 *
 * The waybill is the only thread between EJE's document and the consignment
 * once the goods leave the counter. Without it, "the part never arrived" has
 * nowhere to start. A customer walking out with their own property needs no
 * such reference, so demanding one would be a field they learn to type nonsense
 * into.
 */
export const checkCollectionDetails = (
  job: Pick<Job, 'jobType' | 'courierCollection' | 'waybillNumber'>,
): TransitionCheck => {
  if (!getJobTypeDefinition(job.jobType).collectedOnCompletion) return { allowed: true, violations: [] };
  if (!job.courierCollection) return { allowed: true, violations: [] };
  if (job.waybillNumber.trim().length > 0) return { allowed: true, violations: [] };

  return {
    allowed: false,
    violations: [
      {
        code: 'waybill_required',
        message: 'A waybill number is required for a courier collection.',
      },
    ],
  };
};
