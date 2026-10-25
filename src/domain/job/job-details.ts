import type { Job, JobTypeCode } from '../types/job';
import { getJobTypeDefinition } from './job-types';

/**
 * A JOB'S RECORDED DETAILS, AS THE OFFICE MAY CORRECT THEM. JOB-EDIT-1 (#72).
 *
 * Until JOB-EDIT-1 every one of these was written by `createJob` and never
 * again, by anybody: an order number keyed wrong at the counter, or a Test &
 * Repair part number nobody had found on the casting yet, stayed wrong or blank
 * for the life of the job.
 *
 * Flat, and named exactly as the creation request names them, because the edit
 * panel and the creation form describe the same facts and a reader should not
 * have to translate between `repairItem.partNumber` and `repairPartNumber`
 * depending on which screen they came from.
 *
 * Pure, and in the domain rather than the application layer, because the panel
 * needs the same answer the server enforces — which fields this job type
 * carries — and two copies of that list would drift.
 */
export interface JobDetailValues {
  readonly orderNumber: string;
  readonly referenceNumber: string;
  readonly deliveryNote: string;
  readonly quoteNumber: string;
  readonly faultDescription: string;
  readonly repairPartNumber: string;
  readonly repairDescription: string;
  readonly repairQuantity: number | null;
  /** When the unit arrived on the counter (Test & Repair). */
  readonly dateReceived: string | null;
}

export type JobDetailField = keyof JobDetailValues;

/** Every editable detail, in the order the panel shows them. */
export const JOB_DETAIL_FIELDS: readonly JobDetailField[] = [
  'orderNumber',
  'referenceNumber',
  'quoteNumber',
  'deliveryNote',
  'dateReceived',
  'repairPartNumber',
  'repairDescription',
  'repairQuantity',
  'faultDescription',
];

/** What a person reads. The audit trail keys on the field name, not this (AUDIT-2). */
export const JOB_DETAIL_LABELS: Readonly<Record<JobDetailField, string>> = {
  orderNumber: 'Order number',
  referenceNumber: 'Reference number',
  deliveryNote: 'Delivery note',
  quoteNumber: 'Quote number',
  faultDescription: 'Fault description',
  repairPartNumber: 'Part number (unit booked in)',
  repairDescription: 'Description (unit booked in)',
  repairQuantity: 'Quantity (unit booked in)',
  dateReceived: 'Date received',
};

/**
 * The label a screen shows for a field on THIS job type.
 *
 * One exception to `JOB_DETAIL_LABELS`: on a Test & Repair the delivery note
 * field is where the office records whichever reference came in with the unit
 * — the customer's delivery note or the courier's waybill — and the owner named
 * it "Delivery Note / Waybill Number". On a parts collection it stays a
 * delivery note, because there the courier's waybill is a separate field
 * (`Job.waybillNumber`) asked at the collection.
 */
export const jobDetailLabel = (field: JobDetailField, jobType: JobTypeCode): string =>
  field === 'deliveryNote' && jobType === 'test_and_repair'
    ? 'Delivery note / waybill number'
    : JOB_DETAIL_LABELS[field];

/** The details as the job records them now. */
export const jobDetailValues = (job: Job): JobDetailValues => ({
  orderNumber: job.orderNumber,
  referenceNumber: job.referenceNumber,
  deliveryNote: job.deliveryNote,
  quoteNumber: job.quoteNumber,
  faultDescription: job.faultDescription,
  repairPartNumber: job.repairItem.partNumber,
  repairDescription: job.repairItem.description,
  repairQuantity: job.repairItem.quantity,
  dateReceived: job.dateReceived,
});

/**
 * Which details this job type carries, and so which may be edited on it.
 *
 * EXACTLY THE FIELDS `createJob` KEEPS for the type — nothing is offered for
 * editing that creation would have refused to store:
 *
 *   - the order and reference numbers, on every type;
 *   - the delivery note, where `capturesDeliveryNote` (parts, test & repair);
 *   - the quote number, where `capturesQuoteNumber` (test & repair);
 *   - the unit booked in, where `capturesRepairItem` (test & repair);
 *   - the fault description, on every type that is not office-processed — a
 *     parts collection has no such field at all (CR-13).
 */
export const editableDetailFields = (jobType: JobTypeCode): readonly JobDetailField[] => {
  const definition = getJobTypeDefinition(jobType);
  return JOB_DETAIL_FIELDS.filter((field) => {
    switch (field) {
      case 'orderNumber':
      case 'referenceNumber':
        return true;
      case 'deliveryNote':
        return definition.capturesDeliveryNote;
      case 'quoteNumber':
        return definition.capturesQuoteNumber;
      case 'repairPartNumber':
      case 'repairDescription':
      case 'repairQuantity':
      case 'dateReceived':
        return definition.capturesRepairItem;
      case 'faultDescription':
        return !definition.officeProcessed;
    }
  });
};
