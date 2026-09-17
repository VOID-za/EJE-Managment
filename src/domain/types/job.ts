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
  /** Why the snapshot was taken, for the audit trail. */
  readonly reason: 'customer_signature' | 'submission';
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
  | 'submitted'
  | 'closed';

export type LabourRateType = 'normal' | 'overtime' | 'double';

export interface LabourEntry {
  readonly id: LineItemId;
  readonly technicianId: UserId;
  readonly date: IsoDate;
  readonly rateType: LabourRateType;
  readonly hours: number;
  readonly description: string;
  readonly capturedAt: IsoDateTime;
}

export interface TravelEntry {
  readonly id: LineItemId;
  readonly technicianId: UserId;
  readonly date: IsoDate;
  readonly kilometres: number;
  readonly description: string;
  readonly capturedAt: IsoDateTime;
}

export interface PartEntry {
  readonly id: LineItemId;
  readonly partNumber: string;
  readonly description: string;
  readonly quantity: number;
  readonly unitPrice: Cents;
  readonly capturedAt: IsoDateTime;
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

  /** Reason recorded when the job was last moved to `awaiting_spares`. */
  readonly awaitingSparesReason: string;

  /** True when the fixed call-out fee applies to this job. */
  readonly calloutApplied: boolean;

  /**
   * Parts jobs only: a courier is collecting rather than the customer.
   *
   * A courier has no reason to see what the customer paid, so prices are
   * withheld from the collection document. The prices remain on the job for EJE
   * costing — nothing is deleted.
   */
  readonly courierCollection: boolean;

  /**
   * The rates this job is priced at, frozen when the customer signed.
   *
   * Null while the job is still being worked, in which case current system
   * settings apply. Once set it is never recalculated, so changing a rate can
   * never alter a job card the customer has already signed.
   */
  readonly pricingSnapshot: PricingSnapshot | null;

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
