import {
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
  type CustomerSignature,
  type DeliveryRecord,
  type FinalDocument,
  type Job,
  type JobCancellation,
  type JobNote,
  type LabourEntry,
  type PartEntry,
  type PricingSnapshot,
  type SignatureRefusal,
  type TravelEntry,
} from '@/domain';
import type * as schema from '@/db/schema';

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
type NoteRow = typeof schema.jobNotes.$inferSelect;
type MediaRow = typeof schema.jobMedia.$inferSelect;
type SignatureRow = typeof schema.jobSignatures.$inferSelect;
type RefusalRow = typeof schema.signatureRefusals.$inferSelect;
type SnapshotRow = typeof schema.pricingSnapshots.$inferSelect;
type FinalDocumentRow = typeof schema.finalDocuments.$inferSelect;
type DeliveryAttemptRow = typeof schema.deliveryAttempts.$inferSelect;
type TechnicianRow = typeof schema.jobTechnicians.$inferSelect;

/** Everything the repository loads to assemble one job. */
export interface JobRowSet {
  readonly job: JobRow;
  readonly technicians: readonly TechnicianRow[];
  readonly labour: readonly LabourRow[];
  readonly travel: readonly TravelRow[];
  readonly parts: readonly PartRow[];
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
  fileName: row.fileName,
  caption: row.caption,
  storageKey: row.storageKey,
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

const snapshotFrom = (row: SnapshotRow): PricingSnapshot => ({
  labourRates: {
    normal: row.labourNormalCents,
    overtime: row.labourOvertimeCents,
    double: row.labourDoubleCents,
  },
  calloutRate: row.calloutRateCents,
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
  simulated: false,
  issuedTo: row.issuedTo,
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

    awaitingSparesReason: rows.job.awaitingSparesReason,
    calloutApplied: rows.job.calloutApplied,
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
  faultDescription: job.faultDescription,
  primaryTechnicianId: job.primaryTechnicianId,
  calloutApplied: job.calloutApplied,
  courierCollection: job.courierCollection,
  waybillNumber: job.waybillNumber,
  deliveryNote: job.deliveryNote,
  awaitingSparesReason: job.awaitingSparesReason,
  reportFaultFindings: job.completionReport.faultFindings,
  reportDiagnosis: job.completionReport.diagnosis,
  reportWorkPerformed: job.completionReport.workPerformed,
  reportRecommendations: job.completionReport.recommendations,
  reportGeneralNotes: job.completionReport.generalNotes,
  cancellationReason: job.cancellation?.reason ?? null,
  cancellationDescription: job.cancellation?.description ?? '',
  cancelledBy: job.cancellation?.cancelledBy ?? null,
  cancelledAt: job.cancellation?.cancelledAt ?? null,
  createdAt: job.createdAt,
  createdBy: job.createdBy,
  acceptedAt: job.acceptedAt,
  completedAt: job.completedAt,
  submittedAt: job.submittedAt,
  closedAt: job.closedAt,
});
