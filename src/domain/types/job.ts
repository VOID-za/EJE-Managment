import type { DeliveryRecord } from './delivery';
import type {
  Attachment,
  Cents,
  ContactId,
  CustomerId,
  IsoDate,
  IsoDateTime,
  JobId,
  LineItemId,
  MachineId,
  SiteId,
  UserId,
} from './common';
import type { ChecklistInstance } from './checklist';
import type { PricingInputs } from './settings';

/**
 * The pricing that was in force when a job became a financial commitment, with
 * the moment it was frozen.
 */
export interface PricingSnapshot extends PricingInputs {
  readonly capturedAt: IsoDateTime;
  /**
   * Why the snapshot was taken, for the audit trail.
   *
   * A refusal freezes the rates exactly as a signature does: the work is
   * finished and the figure is the figure, whether or not the customer put
   * their name to it. Recorded distinctly so the trail says which happened.
   */
  readonly reason: 'customer_signature' | 'signature_refused' | 'submission';
}

/**
 * Job types are a closed union for the demo. The `JobTypeDefinition` records in
 * `src/domain/job/job-types.ts` carry the behaviour (checklist required, photos
 * required), so Phase 2 can load those definitions from a `job_types` table
 * without changing any calling code.
 */
export type JobTypeCode =
  | 'breakdown'
  | 'installation'
  | 'service'
  | 'test_and_repair'
  /**
   * A parts collection / delivery note, not a service visit. The customer or a
   * courier collects parts from the EJE office, so there is no labour and no
   * travel — only parts lines and a collector's signature.
   */
  | 'parts';

export type JobPriority = 'low' | 'normal' | 'high' | 'urgent';

/**
 * The EJE job lifecycle.
 *
 * draft -> open -> in_progress -> (awaiting_spares <-> in_progress)*
 *       -> completion -> customer_signature -> review -> submitted -> closed
 *
 * `awaiting_spares` may be entered and left any number of times.
 */
export type JobStatus =
  | 'draft'
  | 'open'
  | 'in_progress'
  | 'awaiting_spares'
  | 'completion'
  | 'customer_signature'
  | 'review'
  /**
   * Submitted by the technician, and waiting on the customer's copy reaching
   * them.
   *
   * The job card is signed, the final document exists and has been sent, but
   * the provider has not confirmed delivery. The job is NOT closed: a job card
   * the customer never received is not a job card that has been issued. It is
   * also no longer editable — the document has gone out, and the record must
   * keep matching it.
   */
  | 'awaiting_delivery'
  /**
   * Historical: handed to the office for Master Review.
   *
   * No longer reached by new work — a technician's submission now issues the
   * job card directly — but kept so jobs that went through that stage stay
   * readable and can still be issued.
   */
  | 'submitted'
  | 'closed'
  /**
   * A legitimate job that will not happen — the customer resolved the fault
   * themselves, or withdrew the request. It leaves the active workflow but
   * keeps everything it recorded, and stays searchable. Distinct from deletion,
   * which is for a job that should never have existed at all.
   */
  | 'cancelled';

/**
 * Why a job was cancelled. Required, because "cancelled" on its own tells the
 * office nothing six months later when the customer asks what happened.
 */
export type CancellationReason =
  | 'customer_resolved'
  | 'customer_cancelled'
  | 'duplicate'
  | 'no_longer_required'
  | 'customer_unavailable'
  | 'other';

export const CANCELLATION_REASONS: readonly CancellationReason[] = [
  'customer_resolved',
  'customer_cancelled',
  'duplicate',
  'no_longer_required',
  'customer_unavailable',
  'other',
];

export const cancellationReasonLabel = (reason: CancellationReason): string => {
  switch (reason) {
    case 'customer_resolved':
      return 'Customer resolved issue';
    case 'customer_cancelled':
      return 'Customer cancelled request';
    case 'duplicate':
      return 'Duplicate job';
    case 'no_longer_required':
      return 'No longer required';
    case 'customer_unavailable':
      return 'Customer unavailable';
    case 'other':
      return 'Other';
  }
};

/**
 * The official document a closed job was finalised with.
 *
 * Stored on the job rather than regenerated, so "the final signed job card" is
 * one fixed artefact with one filename. Changing a labour rate, a part price or
 * a checklist template afterwards cannot reach it: the rates are frozen in
 * `pricingSnapshot`, the checklist resolves by its stored version, and this
 * records exactly which document was issued and when.
 */
export interface FinalDocument {
  readonly fileName: string;
  readonly storageKey: string;
  readonly pageCount: number;
  readonly generatedAt: IsoDateTime;
  readonly generatedBy: UserId;
  /** True in the demo, where no file is rendered server-side. */
  readonly simulated: boolean;
  /** Where the signed copy was emailed, recorded with the document. */
  readonly issuedTo: string;
}

export interface JobCancellation {
  readonly reason: CancellationReason;
  readonly description: string;
  readonly cancelledBy: UserId;
  readonly cancelledAt: IsoDateTime;
}

/** Why a technician handed a job on. Required on every transfer. */
export type TransferReason =
  | 'unable_to_attend'
  | 'sick_or_unavailable'
  | 'vehicle_problem'
  | 'scheduling_conflict'
  | 'requires_another_technician'
  | 'customer_requested'
  | 'other';

export const TRANSFER_REASONS: readonly TransferReason[] = [
  'unable_to_attend',
  'sick_or_unavailable',
  'vehicle_problem',
  'scheduling_conflict',
  'requires_another_technician',
  'customer_requested',
  'other',
];

export const transferReasonLabel = (reason: TransferReason): string => {
  switch (reason) {
    case 'unable_to_attend':
      return 'Unable to attend';
    case 'sick_or_unavailable':
      return 'Sick / unavailable';
    case 'vehicle_problem':
      return 'Vehicle problem';
    case 'scheduling_conflict':
      return 'Scheduling conflict';
    case 'requires_another_technician':
      return 'Job requires another technician';
    case 'customer_requested':
      return 'Customer requested a different technician';
    case 'other':
      return 'Other';
  }
};

export type LabourRateType = 'normal' | 'overtime' | 'double';

export interface LabourEntry {
  readonly id: LineItemId;
  /** Whose work these hours are — the technician who attended. */
  readonly technicianId: UserId;
  readonly date: IsoDate;
  readonly rateType: LabourRateType;
  readonly hours: number;
  readonly description: string;
  readonly capturedAt: IsoDateTime;
  /**
   * Who wrote the line down.
   *
   * Usually the same person as `technicianId`. Different when the office
   * captures a technician's work administratively, which the job card and the
   * audit trail both have to be able to say.
   */
  readonly capturedBy: UserId;
}

export interface TravelEntry {
  readonly id: LineItemId;
  /** Whose travel this is. See `LabourEntry.technicianId`. */
  readonly technicianId: UserId;
  readonly date: IsoDate;
  readonly kilometres: number;
  readonly description: string;
  readonly capturedAt: IsoDateTime;
  /**
   * Who wrote the line down.
   *
   * Usually the same person as `technicianId`. Different when the office
   * captures a technician's work administratively, which the job card and the
   * audit trail both have to be able to say.
   */
  readonly capturedBy: UserId;
}

export interface PartEntry {
  readonly id: LineItemId;
  readonly partNumber: string;
  readonly description: string;
  readonly quantity: number;
  readonly unitPrice: Cents;
  readonly capturedAt: IsoDateTime;
  /**
   * Who wrote the line down.
   *
   * Usually the same person as `technicianId`. Different when the office
   * captures a technician's work administratively, which the job card and the
   * audit trail both have to be able to say.
   */
  readonly capturedBy: UserId;
}


export interface JobNote {
  readonly id: string;
  readonly body: string;
  readonly authorId: UserId;
  readonly createdAt: IsoDateTime;
  /** Internal notes never appear on the customer job card. */
  readonly internal: boolean;
}

export interface CustomerSignature {
  readonly customerName: string;
  readonly customerSurname: string;
  /** Serialised signature strokes captured on the tablet. */
  readonly strokeData: string;
  readonly signedAt: IsoDateTime;
  readonly declaration: string;
}

/**
 * How the office dealt with a customer's refusal to sign.
 *
 * Two outcomes, and the difference is what the customer ends up holding:
 *
 * - `resubmitted` — the job card was corrected and put back in front of the
 *   customer. This is the normal answer: a refusal usually means something on
 *   the card was wrong or missing, and the fix is to correct it and ask again.
 * - `issued_unsigned` — the office accepted the refusal and issued the job card
 *   as it stands, which is the document that says the customer would not sign.
 *   For the customer who will not sign whatever is put in front of them.
 */
export type RefusalResolution = 'resubmitted' | 'issued_unsigned';

/**
 * The customer would not sign.
 *
 * A refusal is an OUTCOME of the signature stage, not a failure of it: the work
 * was done and written up, and the person on site declined to put their name to
 * it. Recording that honestly is the whole point — the alternative is a
 * technician pressed into signing on the customer's behalf, which is what a
 * signed job card exists to prevent.
 *
 * It is a record rather than a flag because every question the office will ask
 * later needs an answer: why, who took it, and when. `resolved*` is what the
 * office then did about it, which is what allows the job card to move on; see
 * `checkReadyForSubmission`. It is a condition ON the job — the job's status
 * stays `review`, and no stage is added anywhere for it.
 */
export interface SignatureRefusal {
  /**
   * Always true.
   *
   * Present so the stored record reads as a fact rather than as the absence of
   * one, and so a refusal cannot be confused with a partially written record.
   */
  readonly refused: true;
  /** Why the customer would not sign. Required, and never blank. */
  readonly reason: string;
  readonly recordedBy: UserId;
  readonly recordedAt: IsoDateTime;
  /** Who resolved the refusal — a Master or a Coordinator. Null until one has. */
  readonly resolvedBy: UserId | null;
  readonly resolvedAt: IsoDateTime | null;
  /** What was done about it. Null while the refusal is still outstanding. */
  readonly resolution: RefusalResolution | null;
  /** What the office decided. Optional — the resolution itself is the act. */
  readonly resolutionNote: string;
}

/** Free-text work write-up captured by the technician at completion. */
export interface JobCompletionReport {
  readonly faultFindings: string;
  readonly diagnosis: string;
  readonly workPerformed: string;
  readonly recommendations: string;
  readonly generalNotes: string;
}

export const emptyCompletionReport = (): JobCompletionReport => ({
  faultFindings: '',
  diagnosis: '',
  workPerformed: '',
  recommendations: '',
  generalNotes: '',
});

export interface Job {
  readonly id: JobId;
  readonly jobNumber: string;
  readonly customerId: CustomerId;
  readonly siteId: SiteId;
  readonly contactId: ContactId;
  /**
   * The machine the job is against.
   *
   * Null for a parts collection, which is a receipt for goods rather than work
   * on a machine. Every other job type has one.
   */
  readonly machineId: MachineId | null;
  readonly jobType: JobTypeCode;
  readonly priority: JobPriority;
  readonly status: JobStatus;
  /** First day of the booking. For most job types this is the only date. */
  readonly scheduledDate: IsoDate | null;
  /**
   * Last day of the booking, INCLUSIVE.
   *
   * Service work is quoted for a number of days, so a service job occupies a
   * range on the calendar rather than a single day. Null on job types that are
   * booked for one day; see `JobTypeDefinition.schedulesDateRange`.
   */
  readonly scheduledEndDate: IsoDate | null;
  readonly orderNumber: string;
  readonly referenceNumber: string;
  readonly faultDescription: string;
  readonly attachments: readonly Attachment[];

  readonly primaryTechnicianId: UserId | null;
  readonly additionalTechnicianIds: readonly UserId[];

  readonly labour: readonly LabourEntry[];
  readonly travel: readonly TravelEntry[];
  readonly parts: readonly PartEntry[];
  readonly photos: readonly Attachment[];
  readonly videos: readonly Attachment[];
  readonly notes: readonly JobNote[];

  readonly completionReport: JobCompletionReport;
  readonly checklist: ChecklistInstance | null;
  readonly signature: CustomerSignature | null;

  /**
   * Every time the customer would not sign, oldest first.
   *
   * A LIST, because a refusal is not the end of the conversation: the office
   * corrects the job card and puts it back in front of the customer, who may
   * sign — or refuse again, for a different reason. Each attempt is its own
   * record and none of them is ever overwritten, so "why did this take three
   * visits" has an answer.
   *
   * The last entry is the current one; see `currentRefusal` and
   * `outstandingRefusal`. An OUTSTANDING refusal (the last one, unresolved) is
   * mutually exclusive with `signature` — `checkSignatureOutcome` enforces it
   * in the domain, not merely on the screens. Empty on every job whose customer
   * signed first time, and on every job that has not reached the signature
   * stage.
   */
  readonly signatureRefusals: readonly SignatureRefusal[];

  /** Reason recorded when the job was last moved to `awaiting_spares`. */
  readonly awaitingSparesReason: string;

  /** True when the fixed call-out fee applies to this job. */
  readonly calloutApplied: boolean;

  /**
   * Collection jobs only: a courier is collecting rather than the customer.
   *
   * A courier has no reason to see what the customer paid, so prices are
   * withheld from the collection document. The prices remain on the job for EJE
   * costing — nothing is deleted. Set when the job is raised and confirmed
   * again at the collection, because who actually turns up is not always who
   * was expected.
   */
  readonly courierCollection: boolean;

  /**
   * The courier's waybill number. Required for a courier collection.
   *
   * It is the only thing that ties EJE's document to the consignment once the
   * goods leave the counter: without it a query about a missing part has
   * nowhere to start. Empty on a customer collection, which needs none.
   */
  readonly waybillNumber: string;

  /**
   * The customer's own delivery note reference, if they work by one.
   *
   * Optional everywhere. Some customers reconcile parts and workshop repairs
   * against a delivery note number rather than an order number, and a document
   * that cannot quote it back is a document their accounts department cannot
   * match. Offered on the job types where it is actually used — see
   * `JobTypeDefinition.capturesDeliveryNote`.
   */
  readonly deliveryNote: string;

  /**
   * The rates this job is priced at, frozen when the customer signed.
   *
   * Null while the job is still being worked, in which case current system
   * settings apply. Once set it is never recalculated, so changing a rate can
   * never alter a job card the customer has already signed.
   */
  readonly pricingSnapshot: PricingSnapshot | null;

  /**
   * Set once, when a Master finalises the job. Never regenerated.
   *
   * Its presence is what makes a closed job's paperwork answerable years later.
   */
  readonly finalDocument: FinalDocument | null;

  /**
   * What became of the customer's copy of the final job card.
   *
   * Null until the job card is issued. The job closes only when this reaches
   * `delivered` — an accepted send is not a received mail.
   */
  readonly delivery: DeliveryRecord | null;

  /** Set when the job was cancelled. Never cleared. */
  readonly cancellation: JobCancellation | null;

  /*
   * There is no soft deletion.
   *
   * A job created by mistake is DELETED — the row and its children go, and the
   * audit event recording who deleted it and why is written first and outlives
   * it. Keeping a marked-deleted job would mean a record that is neither a job
   * nor gone, appearing in exactly the lists somebody forgot to filter.
   *
   * Deletion is refused once a technician has accepted the job: at that point
   * there is real work attached and CANCELLING is the honest action. A
   * cancelled job keeps everything it recorded and stays searchable — that is a
   * different thing from deletion and is unchanged.
   */

  readonly createdAt: IsoDateTime;
  readonly createdBy: UserId;
  readonly acceptedAt: IsoDateTime | null;
  readonly completedAt: IsoDateTime | null;
  readonly submittedAt: IsoDateTime | null;
  readonly closedAt: IsoDateTime | null;
}

export const SIGNATURE_DECLARATION =
  'I confirm that the work described above has been completed.';

/** Parts collection is an acknowledgement of receipt, not of work done. */
export const PARTS_COLLECTION_DECLARATION =
  'I confirm that I have collected the parts listed above.';

/**
 * A repaired unit leaving the workshop.
 *
 * Distinct from the parts wording because what is handed over is the customer's
 * own equipment back, not goods sold to them — and distinct from the work
 * declaration because the person collecting is often a driver who did not watch
 * the work and cannot confirm it was done.
 */
export const TEST_REPAIR_COLLECTION_DECLARATION =
  'I confirm that I have collected the items listed above.';
