import type { Cents } from '../types/common';
import type { Job } from '../types/job';

/**
 * Parts collection document rules.
 *
 * The rule that matters commercially: a courier collecting on a customer's
 * behalf has no business seeing what the customer paid. The prices stay on the
 * job for EJE costing — they are withheld from the DOCUMENT, never deleted.
 */
export const showsPricesOnCollectionDocument = (
  job: Pick<Job, 'jobType' | 'courierCollection'>,
): boolean => {
  if (job.jobType !== 'parts') return true;
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
