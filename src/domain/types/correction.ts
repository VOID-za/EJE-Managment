import type { IsoDateTime, JobId, UserId } from './common';

/**
 * A CORRECTION TO AN ISSUED JOB CARD. BD-02, IMMUT-9, AUD-3.
 *
 * THE GAP THIS CLOSES, and it was an acceptance blocker: a signed job card
 * with a genuine error had **no remedy at any layer**. The application refuses
 * every edit, the database refuses every UPDATE, and the office was left with
 * a document that says the wrong thing and no way to say so. "Immutable" was
 * implemented; "and here is what you do instead" was not.
 *
 * THE RULE THE OWNER APPROVED, in their words and in the order they wrote it:
 *
 *   - A signed job card is immutable. Never edit or replace its original
 *     contents, signature, issue date, recorded prices, or original PDF bytes.
 *   - A Master can initiate a correction/addendum LINKED to the original.
 *   - The correction states the reason, author, timestamp, affected fields,
 *     and references to the original.
 *   - The system preserves a complete audit trail.
 *   - The correction must not silently invalidate or replace the original
 *     customer signature.
 *   - Where customer acknowledgement or a new signature is required, the
 *     system must explicitly record it.
 *   - Original and corrected versions remain accessible to authorised users.
 *   - Customer delivery clearly distinguishes the original from the
 *     correction.
 *
 * SO A CORRECTION IS A NEW RECORD, NEVER AN EDIT. It is the shape the
 * immutability trigger's own message asks for — "correct it by adding a new
 * record" — and it carries its OWN document, which is an addendum rather than
 * a re-rendered job card. A re-render would be a different document wearing
 * the original's date, which is the one thing a frozen job card exists to
 * prevent.
 *
 * WHAT IS DELIBERATELY NOT DECIDED HERE. Nothing in this application decides
 * that a given change REQUIRES the customer's acknowledgement — that is a
 * business rule with legal weight and EJE have not stated it. The Master says
 * whether it is required when raising the correction, and the system records
 * what then happened. See `docs/outstanding-scope.md`.
 */

/**
 * WHAT PART OF THE JOB CARD IS WRONG.
 *
 * A closed vocabulary rather than free text, because this is printed on the
 * customer's addendum and read off the audit trail: "labour" has to mean the
 * same thing in both places and in six months' time. `other` exists so a
 * correction nobody anticipated is still recordable, and the narrative carries
 * what it actually was.
 */
export type CorrectedArea =
  | 'labour'
  | 'travel'
  | 'parts'
  | 'charges'
  | 'fault_description'
  | 'work_performed'
  | 'recommendations'
  | 'checklist'
  | 'machine_details'
  | 'customer_details'
  | 'dates'
  | 'other';

export const CORRECTED_AREAS: readonly CorrectedArea[] = [
  'labour',
  'travel',
  'parts',
  'charges',
  'fault_description',
  'work_performed',
  'recommendations',
  'checklist',
  'machine_details',
  'customer_details',
  'dates',
  'other',
];

/** What each area is called on the addendum and on the screen. */
export const CORRECTED_AREA_LABEL: Readonly<Record<CorrectedArea, string>> = {
  labour: 'Labour',
  travel: 'Travel',
  parts: 'Parts and materials',
  charges: 'Charges and totals',
  fault_description: 'Reported fault',
  work_performed: 'Work performed',
  recommendations: 'Recommendations',
  checklist: 'Checklist',
  machine_details: 'Machine details',
  customer_details: 'Customer details',
  dates: 'Dates',
  other: 'Other',
};

export const asCorrectedArea = (value: string): CorrectedArea | null =>
  CORRECTED_AREAS.find((area) => area === value) ?? null;

/**
 * WHETHER THE CUSTOMER HAS TO SAY THEY HAVE SEEN IT.
 *
 * Three states and not a boolean, because "not required" and "required and
 * still outstanding" are different things to the office: one is finished and
 * one is a job half done. `recorded` is the only state that may follow
 * `required`, and it is write-once.
 */
export type AcknowledgementState = 'not_required' | 'required' | 'recorded';

/** What the customer did, when acknowledgement was required and has happened. */
export interface CorrectionAcknowledgement {
  /** The person at the customer who acknowledged it. Their name, as given. */
  readonly acknowledgedBy: string;
  /** How: in person, by telephone, by e-mail. Free text, recorded verbatim. */
  readonly method: string;
  readonly recordedBy: UserId;
  readonly recordedAt: IsoDateTime;
  readonly note: string;
}

export interface JobCorrection {
  readonly id: string;
  readonly jobId: JobId;
  /**
   * 1 for the first correction to this job, 2 for the next.
   *
   * Printed as "Correction 2" on the addendum, so the customer holding three
   * pieces of paper can put them in order.
   */
  readonly sequence: number;
  /**
   * THE DOCUMENT THIS CORRECTS, BY ITS STORAGE KEY — the owner's "references
   * to the original".
   *
   * The key rather than the row id, and that is the point: a storage key names
   * an exact set of BYTES, which is what the customer holds. It is unique on
   * `final_documents` and this is a foreign key to it, so the document a
   * correction refers to cannot be removed from under it. The row id would
   * have meant adding one to the domain's `FinalDocument` purely to be a
   * handle, and a handle is not what a correction is about.
   */
  readonly correctsDocumentKey: string;
  /** Why the original is wrong. Required, and never blank. */
  readonly reason: string;
  /** What the correction actually says. Required; printed in full. */
  readonly narrative: string;
  /** Which parts of the job card are affected. At least one. */
  readonly areas: readonly CorrectedArea[];
  readonly raisedBy: UserId;
  readonly raisedAt: IsoDateTime;
  readonly acknowledgement: AcknowledgementState;
  /** Null until acknowledgement is recorded, and write-once thereafter. */
  readonly acknowledged: CorrectionAcknowledgement | null;
  /**
   * The addendum's own stored document. Null only in the moment between the
   * row being written and the file being stored — which cannot happen, because
   * the bytes land first.
   */
  readonly documentFileName: string;
  readonly documentStorageKey: string;
  readonly documentSizeBytes: number;
  readonly documentChecksumSha256: string | null;
  readonly createdAt: IsoDateTime;
}

/** A correction still waiting for the customer to acknowledge it. */
export const awaitsAcknowledgement = (
  correction: Pick<JobCorrection, 'acknowledgement'>,
): boolean => correction.acknowledgement === 'required';

/** How the addendum names itself, on the document and in the file name. */
export const correctionTitle = (
  correction: Pick<JobCorrection, 'sequence'>,
  jobNumber: string,
): string => `Correction ${correction.sequence} to job card ${jobNumber}`;

export const correctionFileName = (
  correction: Pick<JobCorrection, 'sequence'>,
  jobNumber: string,
): string => `${jobNumber}-correction-${correction.sequence}.pdf`;

/**
 * A MASTER'S AUTHORISATION TO SEND A JOB CARD THE CUSTOMER DID NOT SIGN.
 * BD-06, DELIV-7, AUD-4.
 *
 * WHAT WAS TRUE BEFORE IT, and it was an acceptance blocker: closing a job
 * without a signature sent the customer **nothing**. The unsigned document was
 * rendered, stored and downloadable, and the send was left open as a business
 * decision. The default was right — a customer who declined to sign must not
 * be e-mailed a copy automatically — and it left EJE with no way to send one
 * at all.
 *
 * SO IT IS AN EXPLICIT ACT, and this is the record of it: who decided, when,
 * why, which document, and to whom. The outcome of each attempt is NOT here —
 * it is on `job.delivery` and in the audit trail, where every other delivery
 * attempt in this system is recorded, because an authorisation is a decision
 * and a delivery is an event.
 *
 * THE RECIPIENT IS NOT A FREE CHOICE. It is the address the document was
 * issued to, which was selected by the existing customer-communication rules
 * when the job card was produced. A Master authorising a send is not also
 * choosing a new destination for it.
 */
export interface UnsignedDeliveryAuthorisation {
  readonly id: string;
  readonly jobId: JobId;
  /** The exact bytes authorised, by storage key. */
  readonly documentKey: string;
  readonly recipient: string;
  readonly reason: string;
  readonly authorisedBy: UserId;
  readonly authorisedAt: IsoDateTime;
  readonly createdAt: IsoDateTime;
}
