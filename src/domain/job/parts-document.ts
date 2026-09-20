import type { Cents } from '../types/common';
import type { Job } from '../types/job';
import { getJobTypeDefinition } from './job-types';
import type { TransitionCheck } from './workflow';

/**
 * Collection document rules.
 *
 * The rule that matters commercially: a courier collecting on a customer's
 * behalf has no business seeing what the customer paid. The prices stay on the
 * job for EJE costing — they are withheld from the DOCUMENT, never deleted.
 *
 * It applies to every job whose work is collected from the counter, which is
 * parts AND a workshop test and repair: a driver picking up a repaired spindle
 * drive is in exactly the position a driver picking up a box of filters is.
 */
export const showsPricesOnCollectionDocument = (
  job: Pick<Job, 'jobType' | 'courierCollection'>,
): boolean => {
  if (!getJobTypeDefinition(job.jobType).collectedOnCompletion) return true;
  return !job.courierCollection;
};

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
