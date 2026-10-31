import {
  asCorrectedArea,
  asProvenance,
  asAttachmentId,
  asContactId,
  asCustomerId,
  asJobId,
  asLineItemId,
  asMachineId,
  asSiteId,
  asUserId,
  emptyDelivery,
  type Attachment,
  type ChecklistInstance,
  type CorrectedArea,
  type CustomerSignature,
  type DeliveryRecord,
  type FinalDocument,
  type Job,
  type RepairItem,
  type JobCancellation,
  type JobInvoice,
  type JobOfficeHandling,
  type JobCorrection,
  type JobNote,
  type LabourEntry,
  type AdditionalChargeEntry,
  type JobDiscount,
  type PartEntry,
  type PricingSnapshot,
  type SignatureRefusal,
  type TravelEntry,
  isDeliveryFailureKind,
} from '@/domain';
import type * as schema from '@/db/schema';

/**
 * The parts booked in after the first (TR-PARTS-1, 0041), read defensively: a
 * column written by hand, or by a future release, never puts a malformed part
 * on screen — anything that is not a part is left out.
 */
export const repairItemsFromColumn = (value: unknown): RepairItem[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        .map((item) => ({
          partNumber: typeof item.partNumber === 'string' ? item.partNumber : '',
          description: typeof item.description === 'string' ? item.description : '',
          quantity: typeof item.quantity === 'number' && Number.isInteger(item.quantity) && item.quantity > 0 ? item.quantity : null,
        }))
        .filter((item) => item.partNumber.length > 0 || item.description.length > 0 || item.quantity !== null)
    : [];


/**
 * Rows to the domain, and back.
 *
 * The `Job` type does not change. The database decomposes the aggregate into a
 * root and its children because they are genuinely separate records with their
 * own authors and lifecycles; this module puts them back together so everything
 * above the repository sees exactly the object it always saw.
 *
 * Nothing here decides anything. There is no business rule in this file — it is
 * a translation, and a rule that appeared here would be a rule the tests in
 * `src/domain` do not cover.
 */

type JobRow = typeof schema.jobs.$inferSelect;
type LabourRow = typeof schema.jobLabour.$inferSelect;
type TravelRow = typeof schema.jobTravel.$inferSelect;
type PartRow = typeof schema.jobParts.$inferSelect;
type AdditionalChargeRow = typeof schema.jobAdditionalCharges.$inferSelect;
type NoteRow = typeof schema.jobNotes.$inferSelect;
type MediaRow = typeof schema.jobMedia.$inferSelect;
type SignatureRow = typeof schema.jobSignatures.$inferSelect;
type RefusalRow = typeof schema.signatureRefusals.$inferSelect;
type SnapshotRow = typeof schema.pricingSnapshots.$inferSelect;
type FinalDocumentRow = typeof schema.finalDocuments.$inferSelect;
type CorrectionRow = typeof schema.jobCorrections.$inferSelect;
type DeliveryAttemptRow = typeof schema.deliveryAttempts.$inferSelect;
type TechnicianRow = typeof schema.jobTechnicians.$inferSelect;

/** Everything the repository loads to assemble one job. */
export interface JobRowSet {
  readonly job: JobRow;
  readonly technicians: readonly TechnicianRow[];
  readonly labour: readonly LabourRow[];
  readonly travel: readonly TravelRow[];
  readonly parts: readonly PartRow[];
  /** COST-5. Empty on almost every job. */
  readonly additionalCharges: readonly AdditionalChargeRow[];
  readonly notes: readonly NoteRow[];
  readonly media: readonly MediaRow[];
  readonly signature: SignatureRow | null;
  readonly refusals: readonly RefusalRow[];
  readonly snapshot: SnapshotRow | null;
  readonly finalDocument: FinalDocumentRow | null;
  /** Newest first. The domain carries the latest state; the table keeps them all. */
  readonly deliveryAttempts: readonly DeliveryAttemptRow[];
  readonly checklist: ChecklistInstance | null;
}

/** VAT is stored as hundredths of a percent so it is exact; the domain reads a percentage. */
export const vatPercentFromBasisPoints = (basisPoints: number): number => basisPoints / 100;
export const vatBasisPointsFromPercent = (percent: number): number => Math.round(percent * 100);

const numberFrom = (value: string | null): number => (value === null ? 0 : Number(value));

const attachmentFrom = (row: MediaRow): Attachment => ({
  id: asAttachmentId(row.id),
  kind: row.kind,
  visibility: row.visibility,
  fileName: row.fileName,
  caption: row.caption,
  storageKey: row.storageKey,
  checksumSha256: row.checksumSha256,
  /*
   * JOB MEDIA IS ALWAYS GENUINE, and that is a fact about this system rather
   * than a default: every path that records one stores bytes first and the
   * row second (MEDIA-6), and the seed creates none. There is no column.
   */
  provenance: 'genuine' as const,
  uploadedAt: row.uploadedAt,
  uploadedBy: asUserId(row.uploadedBy ?? ''),
  sizeBytes: row.sizeBytes,
});

const labourFrom = (row: LabourRow): LabourEntry => ({
  id: asLineItemId(row.id),
  technicianId: asUserId(row.technicianId ?? ''),
  date: row.workDate,
  rateType: row.rateType,
  hours: numberFrom(row.hours),
  description: row.description,
  capturedAt: row.capturedAt,
  capturedBy: asUserId(row.capturedBy ?? ''),
});

const travelFrom = (row: TravelRow): TravelEntry => ({
  id: asLineItemId(row.id),
  technicianId: asUserId(row.technicianId ?? ''),
  date: row.travelDate,
  kilometres: numberFrom(row.kilometres),
  description: row.description,
  capturedAt: row.capturedAt,
  capturedBy: asUserId(row.capturedBy ?? ''),
});

const partFrom = (row: PartRow): PartEntry => ({
  id: asLineItemId(row.id),
  partNumber: row.partNumber,
  description: row.description,
  quantity: row.quantity,
  unitPrice: row.unitPriceCents,
  capturedAt: row.capturedAt,
  capturedBy: asUserId(row.capturedBy ?? ''),
});

const additionalChargeFrom = (row: AdditionalChargeRow): AdditionalChargeEntry => ({
  id: asLineItemId(row.id),
  description: row.description,
  amount: row.amountCents,
  capturedAt: row.capturedAt,
  capturedBy: asUserId(row.capturedBy ?? ''),
});

/**
 * The discount, from the four columns that carry it. COST-5.
 *
 * All four or none: the database refuses anything else
 * (`jobs_discount_is_whole_or_absent`), and this reads the amount as the one
 * that decides — so a row that somehow carried a reason alone presents as no
 * discount rather than as a discount of nothing.
 */
const discountFrom = (row: JobRow): JobDiscount | null =>
  row.discountCents === null || row.discountAuthorisedAt === null
    ? null
    : {
        amount: row.discountCents,
        reason: row.discountReason,
        authorisedBy: asUserId(row.discountAuthorisedBy ?? ''),
        authorisedAt: row.discountAuthorisedAt,
      };

const noteFrom = (row: NoteRow): JobNote => ({
  id: row.id,
  body: row.body,
  authorId: asUserId(row.authorId ?? ''),
  createdAt: row.createdAt,
  internal: row.internal,
});

const signatureFrom = (row: SignatureRow): CustomerSignature => ({
  customerName: row.customerName,
  customerSurname: row.customerSurname,
  strokeData: row.strokeData,
  signedAt: row.signedAt,
  declaration: row.declaration,
});

/**
 * A refusal, oldest first.
 *
 * The reason comes from HERE and from nowhere else. It is never copied onto the
 * audit trail, so `canSeeSignatureRefusal` and `redactRefusalsForViewer` govern
 * exactly one copy of it.
 */
export const refusalFrom = (row: RefusalRow): SignatureRefusal => ({
  refused: true,
  reason: row.reason,
  recordedBy: asUserId(row.recordedBy),
  recordedAt: row.recordedAt,
  resolvedBy: row.resolvedBy === null ? null : asUserId(row.resolvedBy),
  resolvedAt: row.resolvedAt,
  resolution: row.resolution,
  resolutionNote: row.resolutionNote,
});

/**
 * A CORRECTION TO AN ISSUED JOB CARD. BD-02.
 *
 * `areas` is read through the domain's own parser and anything unrecognised is
 * DROPPED rather than carried: a correction printed with an area this build
 * cannot label would say "undefined" on a customer's addendum. The CHECK
 * constraint makes an empty result unreachable through the application, and if
 * a hand-written row managed it the correction would read as affecting nothing
 * — which is visible, unlike a silent mislabel.
 */
export const correctionFrom = (row: CorrectionRow): JobCorrection => ({
  id: row.id,
  jobId: asJobId(row.jobId),
  sequence: row.sequence,
  correctsDocumentKey: row.correctsDocumentKey,
  reason: row.reason,
  narrative: row.narrative,
  areas: row.areas
    .map((area) => asCorrectedArea(area))
    .filter((area): area is CorrectedArea => area !== null),
  raisedBy: asUserId(row.raisedBy ?? ''),
  raisedAt: row.raisedAt,
  acknowledgement:
    row.acknowledgement === 'required'
      ? 'required'
      : row.acknowledgement === 'recorded'
        ? 'recorded'
        : 'not_required',
  acknowledged:
    row.acknowledgement === 'recorded' && row.acknowledgedBy !== null
      ? {
          acknowledgedBy: row.acknowledgedBy,
          method: row.acknowledgementMethod ?? '',
          recordedBy: asUserId(row.acknowledgementRecordedBy ?? ''),
          recordedAt: row.acknowledgementRecordedAt ?? row.raisedAt,
          note: row.acknowledgementNote,
        }
      : null,
  documentFileName: row.documentFileName,
  documentStorageKey: row.documentStorageKey,
  documentSizeBytes: row.documentSizeBytes,
  documentChecksumSha256: row.documentChecksumSha256,
  createdAt: row.createdAt,
});

export const snapshotFrom = (row: SnapshotRow): PricingSnapshot => ({
  labourRates: {
    normal: row.labourNormalCents,
    overtime: row.labourOvertimeCents,
    double: row.labourDoubleCents,
  },
  calloutRate: row.calloutRateCents,
  testBenchFee: row.testBenchFeeCents,
  kilometreRate: row.kilometreRateCents,
  vatPercentage: vatPercentFromBasisPoints(row.vatPercentBasisPoints),
  capturedAt: row.capturedAt,
  reason: row.reason,
});

export const finalDocumentFrom = (row: FinalDocumentRow): FinalDocument => ({
  fileName: row.fileName,
  storageKey: row.storageKey,
  pageCount: row.pageCount,
  generatedAt: row.generatedAt,
  generatedBy: asUserId(row.generatedBy ?? ''),
  // Production bytes are real. The flag stays on the type so a demonstration
  // build can still mark its own documents honestly.
  // A server-side renderer produced these bytes.
  renderedLocally: false,
  issuedTo: row.issuedTo,
  /*
   * ZERO IS READ AS "UNKNOWN", because that is what it means in this column.
   * It defaults to 0 and was never written, so every row that predates
   * BACKUP-1's fix carries one — and a job card is never genuinely 0 bytes.
   */
  sizeBytes: row.sizeBytes === 0 ? null : row.sizeBytes,
  checksumSha256: row.checksumSha256,
  renderer: row.rendererVersion === 0 ? null : row.rendererVersion,
  // Unrecognised reads as `simulated`, which is the SAFE direction here: a
  // value nothing understands must not let a fixture pass as EJE's document.
  provenance: asProvenance(row.provenance),
});

/**
 * The delivery state the job carries, derived from the attempts.
 *
 * The domain holds the CURRENT state; the table holds every attempt, because
 * "we tried three times, here is what the provider said each time" is the
 * question the office actually asks and a counter cannot answer it. The latest
 * attempt is the current state, and `attempts` is simply how many there were.
 */
const deliveryFrom = (
  attempts: readonly DeliveryAttemptRow[],
  fallbackRecipient: string,
  at: string,
): DeliveryRecord | null => {
  const latest = attempts[0];
  if (latest === undefined) {
    return fallbackRecipient.length === 0 ? null : emptyDelivery(fallbackRecipient, at);
  }

  return {
    messageId: latest.providerMessageId ?? '',
    state: latest.state,
    to: latest.recipient,
    acceptedAt: latest.acceptedAt,
    confirmedAt: latest.confirmedAt,
    updatedAt: latest.failedAt ?? latest.confirmedAt ?? latest.acceptedAt ?? latest.attemptedAt,
    attempts: attempts.length,
    failureReason: latest.failureReason,
    /*
     * An unrecognised string reads as UNCLASSIFIED rather than being passed up
     * as a kind nothing can narrow. The column is `text` so a new provider's
     * failure mode needs no migration; this is where that freedom is paid for.
     */
    failureKind: isDeliveryFailureKind(latest.failureKind) ? latest.failureKind : null,
  };
};

const cancellationFrom = (row: JobRow): JobCancellation | null =>
  row.cancellationReason === null || row.cancelledAt === null
    ? null
    : {
        reason: row.cancellationReason,
        description: row.cancellationDescription,
        cancelledBy: asUserId(row.cancelledBy ?? ''),
        cancelledAt: row.cancelledAt,
      };

/** The office's handling of a submitted job card, when there has been one. */
const officeHandlingFrom = (row: JobRow): JobOfficeHandling | null =>
  row.officeHandledBy === null || row.officeHandledAt === null
    ? null
    : { handledBy: asUserId(row.officeHandledBy), handledAt: row.officeHandledAt };

/** The recorded invoice number, when there is one. */
const invoiceFrom = (row: JobRow): JobInvoice | null =>
  row.invoiceNumber === null || row.invoicedBy === null || row.invoicedAt === null
    ? null
    : { number: row.invoiceNumber, recordedBy: asUserId(row.invoicedBy), recordedAt: row.invoicedAt };

/** Assembles the domain `Job` from the root row and its children. */
export const toDomainJob = (rows: JobRowSet): Job => {
  const media = rows.media.filter((row) => row.removedAt === null);

  return {
    id: asJobId(rows.job.id),
    jobNumber: rows.job.jobNumber,
    customerId: asCustomerId(rows.job.customerId),
    siteId: asSiteId(rows.job.siteId),
    contactId: asContactId(rows.job.contactId),
    machineId: rows.job.machineId === null ? null : asMachineId(rows.job.machineId),
    jobType: rows.job.jobTypeCode as Job['jobType'],
    priority: rows.job.priority,
    status: rows.job.status,
    scheduledDate: rows.job.scheduledDate,
    scheduledEndDate: rows.job.scheduledEndDate,
    orderNumber: rows.job.orderNumber,
    referenceNumber: rows.job.referenceNumber,
    // Test & Repair §4. The three text columns default to '' so there is no
    // null-versus-empty ambiguity; the quantity is genuinely nullable.
    repairItem: {
      partNumber: rows.job.repairPartNumber,
      description: rows.job.repairDescription,
      quantity: rows.job.repairQuantity,
    },
    // TR-PARTS-1, 0041: the rest of the parts booked in.
    moreRepairItems: repairItemsFromColumn(rows.job.moreRepairItems),
    quoteNumber: rows.job.quoteNumber,
    dateReceived: rows.job.dateReceived,
    faultDescription: rows.job.faultDescription,

    attachments: media.filter((row) => row.kind === 'document').map(attachmentFrom),
    photos: media.filter((row) => row.kind === 'photo').map(attachmentFrom),
    videos: media.filter((row) => row.kind === 'video').map(attachmentFrom),

    primaryTechnicianId:
      rows.job.primaryTechnicianId === null ? null : asUserId(rows.job.primaryTechnicianId),
    additionalTechnicianIds: rows.technicians.map((row) => asUserId(row.userId)),

    labour: rows.labour.map(labourFrom),
    travel: rows.travel.map(travelFrom),
    parts: rows.parts.map(partFrom),
    additionalCharges: rows.additionalCharges.map(additionalChargeFrom),
    discount: discountFrom(rows.job),
    notes: rows.notes.map(noteFrom),

    completionReport: {
      faultFindings: rows.job.reportFaultFindings,
      diagnosis: rows.job.reportDiagnosis,
      workPerformed: rows.job.reportWorkPerformed,
      recommendations: rows.job.reportRecommendations,
      generalNotes: rows.job.reportGeneralNotes,
    },

    checklist: rows.checklist,
    signature: rows.signature === null ? null : signatureFrom(rows.signature),
    // Oldest first: the last one is the one the office is dealing with, and the
    // rest are how the job got there.
    signatureRefusals: rows.refusals.map(refusalFrom),

    /*
     * A REQUEST, OR NOTHING. SPARE-2.
     *
     * `requested_at` is what decides which. A job that has never waited for
     * spares has null there, and answers null here — rather than a request whose
     * every field is empty, which the screens would then have to tell apart from
     * a real one.
     */
    sparesRequest:
      rows.job.awaitingSparesRequestedAt === null
        ? null
        : {
            description: rows.job.awaitingSparesReason,
            notes: rows.job.awaitingSparesNotes,
            photoId:
              rows.job.awaitingSparesPhotoId === null
                ? null
                : asAttachmentId(rows.job.awaitingSparesPhotoId),
            requestedAt: rows.job.awaitingSparesRequestedAt,
          },
    calloutApplied: rows.job.calloutApplied,
    testBenchApplied: rows.job.testBenchApplied,
    courierCollection: rows.job.courierCollection,
    waybillNumber: rows.job.waybillNumber,
    deliveryNote: rows.job.deliveryNote,

    pricingSnapshot: rows.snapshot === null ? null : snapshotFrom(rows.snapshot),
    finalDocument: rows.finalDocument === null ? null : finalDocumentFrom(rows.finalDocument),
    delivery: deliveryFrom(
      rows.deliveryAttempts,
      rows.finalDocument?.issuedTo ?? '',
      rows.job.updatedAt,
    ),
    cancellation: cancellationFrom(rows.job),
    officeHandling: officeHandlingFrom(rows.job),
    invoice: invoiceFrom(rows.job),

    createdAt: rows.job.createdAt,
    createdBy: asUserId(rows.job.createdBy ?? ''),
    acceptedAt: rows.job.acceptedAt,
    completedAt: rows.job.completedAt,
    submittedAt: rows.job.submittedAt,
    closedAt: rows.job.closedAt,
  };
};

/** The root row for an insert or update. Children are written separately. */
export const toJobRow = (
  job: Job,
  jobNumberSeq: number,
): typeof schema.jobs.$inferInsert => ({
  id: job.id,
  jobNumber: job.jobNumber,
  jobNumberSeq,
  customerId: job.customerId,
  siteId: job.siteId,
  contactId: job.contactId,
  machineId: job.machineId,
  jobTypeCode: job.jobType,
  priority: job.priority,
  status: job.status,
  scheduledDate: job.scheduledDate,
  scheduledEndDate: job.scheduledEndDate,
  orderNumber: job.orderNumber,
  referenceNumber: job.referenceNumber,
  repairPartNumber: job.repairItem.partNumber,
  repairDescription: job.repairItem.description,
  repairQuantity: job.repairItem.quantity,
  moreRepairItems: job.moreRepairItems.map((item) => ({ partNumber: item.partNumber, description: item.description, quantity: item.quantity })),
  quoteNumber: job.quoteNumber,
  dateReceived: job.dateReceived,
  faultDescription: job.faultDescription,
  primaryTechnicianId: job.primaryTechnicianId,
  calloutApplied: job.calloutApplied,
  testBenchApplied: job.testBenchApplied,
  courierCollection: job.courierCollection,
  waybillNumber: job.waybillNumber,
  deliveryNote: job.deliveryNote,
  awaitingSparesReason: job.sparesRequest?.description ?? '',
  awaitingSparesNotes: job.sparesRequest?.notes ?? '',
  awaitingSparesPhotoId: job.sparesRequest?.photoId ?? null,
  awaitingSparesRequestedAt: job.sparesRequest?.requestedAt ?? null,
  reportFaultFindings: job.completionReport.faultFindings,
  reportDiagnosis: job.completionReport.diagnosis,
  reportWorkPerformed: job.completionReport.workPerformed,
  reportRecommendations: job.completionReport.recommendations,
  reportGeneralNotes: job.completionReport.generalNotes,
  cancellationReason: job.cancellation?.reason ?? null,
  cancellationDescription: job.cancellation?.description ?? '',
  cancelledBy: job.cancellation?.cancelledBy ?? null,
  cancelledAt: job.cancellation?.cancelledAt ?? null,
  officeHandledBy: job.officeHandling?.handledBy ?? null,
  officeHandledAt: job.officeHandling?.handledAt ?? null,
  invoiceNumber: job.invoice?.number ?? null,
  invoicedBy: job.invoice?.recordedBy ?? null,
  invoicedAt: job.invoice?.recordedAt ?? null,
  createdAt: job.createdAt,
  createdBy: job.createdBy,
  acceptedAt: job.acceptedAt,
  completedAt: job.completedAt,
  submittedAt: job.submittedAt,
  closedAt: job.closedAt,
});
