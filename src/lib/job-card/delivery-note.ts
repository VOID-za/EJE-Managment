import {
  getJobTypeDefinition,
  requiresDeliveryNote,
  type Contact,
  type Customer,
  type Job,
  type Site,
  type SystemSettings,
  type User,
} from '@/domain';
import { formatDate, formatDateTime } from '@/lib/format';

/**
 * THE COURIER'S DELIVERY NOTE. PARTS-03, PARTS-04 (the real-world reviewer,
 * 28 October 2026).
 *
 * A SEPARATE DOCUMENT FROM THE JOB CARD. The job card stays priced — it is the
 * office's record and the customer's copy — and the delivery note goes with
 * the goods. What it carries was settled by the repository's own rule for a
 * courier's copy (\`showsPricesOnCollectionDocument\`, BD and CR history): the
 * goods and how many, the references the customer reconciles by, the waybill,
 * and NEVER a price — no rate, no line total, no VAT, no total. Nothing on it is
 * new information: every value is already on the job.
 *
 * Built here, once, and drawn by both the PDF renderer and the on-screen
 * document, so the two cannot disagree. Generating it never changes the job,
 * never touches the issued job card, and is recorded on the activity trail.
 */
export interface DeliveryNoteModel {
  readonly title: 'Delivery Note';
  readonly company: {
    readonly name: string;
    readonly address: string;
    readonly contactLine: string;
  };
  readonly jobNumber: string;
  /** Whom the goods are going to. */
  readonly deliverTo: readonly string[];
  readonly details: readonly { readonly label: string; readonly value: string }[];
  readonly items: readonly {
    readonly kind: 'Repaired unit' | 'Part';
    readonly partNumber: string;
    readonly description: string;
    readonly quantity: string;
  }[];
  readonly totalQuantity: string;
  readonly priceNote: string;
  /**
   * THE COURIER'S SIGNATURE — taken ONCE, on this document. It is the job's
   * signature (`Job.signature`); the priced job card refers to it rather than
   * claiming a second signing. Null until the courier has signed.
   */
  readonly signature: {
    readonly declaration: string;
    readonly name: string;
    readonly signedAt: string;
    readonly signatureData: string;
    /** Printed on BOTH documents, so each can be traced to this one signing act. */
    readonly reference: string;
  } | null;
  readonly footer: string;
}

/**
 * The reference that ties the priced job card to the Delivery Note the courier
 * signed: the job number and the moment of the one signature. Printed on both
 * documents; the issued delivery-note record also keeps the SHA-256 of the
 * signature's stroke data.
 */
export const courierSignatureReference = (job: Pick<Job, 'jobNumber' | 'signature'>): string | null =>
  job.signature === null ? null : `${job.jobNumber}-S${job.signature.signedAt.replace(/\D/gu, '').slice(0, 14)}`;

/**
 * What a Delivery Note's IDENTITY is drawn from (BD-23): the document the
 * courier was shown, without the outcome block (the signature they add) or the
 * footer (when it was rendered). See `documentIdentityFor`.
 */
export const identifiedDeliveryNoteContent = (
  model: DeliveryNoteModel,
): Omit<DeliveryNoteModel, 'signature' | 'footer'> => {
  const { signature: _signature, footer: _footer, ...rest } = model;
  return rest;
};

export interface DeliveryNoteInput {
  readonly job: Job;
  readonly customer: Customer;
  readonly site: Site;
  readonly contact: Contact | null;
  readonly settings: SystemSettings;
  readonly users: readonly Pick<User, 'id' | 'firstName' | 'lastName'>[];
}

export const deliveryNoteFileName = (job: Pick<Job, 'jobNumber'>): string => `${job.jobNumber}-Delivery-Note.pdf`;

export const buildDeliveryNoteModel = (input: DeliveryNoteInput, generatedAt: string): DeliveryNoteModel => {
  const { job, customer, site, contact, settings } = input;
  const definition = getJobTypeDefinition(job.jobType);
  const repairItem =
    definition.capturesRepairItem && (job.repairItem.partNumber.length > 0 || job.repairItem.description.length > 0)
      ? [{
          kind: 'Repaired unit' as const,
          partNumber: job.repairItem.partNumber,
          description: job.repairItem.description,
          quantity: String(job.repairItem.quantity ?? 1),
        }]
      : [];
  const parts = job.parts.map((part) => ({
    kind: 'Part' as const,
    partNumber: part.partNumber,
    description: part.description,
    quantity: String(part.quantity),
  }));
  const items = [...repairItem, ...parts];
  const totalQuantity = items.reduce((total, item) => total + Number(item.quantity), 0);
  const address = [site.addressLine1, site.addressLine2, site.city, site.province, site.postalCode]
    .filter((part) => part.trim().length > 0)
    .join(', ');
  const optional = (label: string, value: string) => (value.trim().length > 0 ? [{ label, value: value.trim() }] : []);
  return {
    title: 'Delivery Note',
    company: {
      name: settings.companyName,
      address: settings.companyAddress,
      contactLine: `Tel ${settings.companyPhone} · ${settings.companyEmail}`,
    },
    jobNumber: job.jobNumber,
    deliverTo: [
      customer.name,
      `${site.name}${address.length > 0 ? ` — ${address}` : ''}`,
      ...(contact === null ? [] : [`Attention: ${contact.firstName} ${contact.lastName}`.trim()]),
    ],
    details: [
      { label: 'Job type', value: definition.label },
      { label: 'Collection', value: 'Courier collection' },
      ...optional('Waybill', job.waybillNumber),
      ...optional('Customer order number', job.orderNumber),
      ...optional('Delivery note / waybill (customer)', job.deliveryNote),
      ...optional('Quote number', definition.capturesQuoteNumber ? job.quoteNumber : ''),
      ...optional('Reference', job.referenceNumber),
      { label: 'Date', value: formatDate(generatedAt.slice(0, 10)) },
    ],
    items,
    totalQuantity: String(totalQuantity),
    priceNote: 'No prices are shown on a delivery note. The priced job card is kept by EJE and sent to the customer.',
    signature:
      job.signature === null
        ? null
        : {
            declaration: job.signature.declaration,
            name: `${job.signature.customerName} ${job.signature.customerSurname}`,
            signedAt: formatDateTime(job.signature.signedAt),
            signatureData: job.signature.strokeData,
            reference: courierSignatureReference(job) ?? '',
          },
    footer: `${settings.companyName} · ${job.jobNumber} · Delivery Note · Generated ${formatDateTime(generatedAt)}`,
  };
};

/** Why a delivery note cannot be produced for this job, or null when it can. */
export const deliveryNoteUnavailable = (job: Pick<Job, 'jobType' | 'courierCollection' | 'status'>): string | null => {
  if (!getJobTypeDefinition(job.jobType).collectedOnCompletion) {
    return 'Only a Parts or a Test & Repair job is collected, so only those have a delivery note.';
  }
  if (!requiresDeliveryNote(job)) {
    return 'A delivery note goes with a courier collection. Record the collection as a courier collection first.';
  }
  return null;
};

