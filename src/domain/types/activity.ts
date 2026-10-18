import type { ActivityId, IsoDateTime, JobId, UserId } from './common';

/**
 * Audit events. The demo records these into the same repository the UI reads,
 * which keeps the write path honest: nothing appears on a timeline unless the
 * business logic actually emitted it.
 */
export type ActivityEventType =
  | 'job_created'
  | 'job_assigned'
  | 'job_accepted'
  | 'site_location_sent'
  | 'site_location_declined'
  | 'site_location_failed'
  /**
   * The assignment notification reached the technician's channels.
   *
   * Recorded separately from `job_assigned`, because they are different facts:
   * one says the office gave somebody the work, the other says the system
   * managed to tell them. A business that uses WhatsApp to reach technicians
   * needs to know when the second did not happen.
   */
  | 'assignment_notified'
  /** The technician was assigned and could NOT be told. Says why. */
  | 'assignment_notification_failed'
  | 'technician_added'
  | 'technician_removed'
  | 'note_added'
  | 'photo_uploaded'
  /** An attachment taken off the job, and by whom. */
  | 'photo_removed'
  /**
   * A photograph reclassified as the customer's or as EJE's own. MEDIA-1.
   *
   * Its own type rather than a second `photo_uploaded`: what changed is who the
   * photograph is FOR, which decides whether its caption appears on the document
   * the customer signs. A trail that could not tell that from an upload could not
   * answer why last month's job card shows two photographs and this month's shows
   * three.
   */
  | 'photo_visibility_changed'
  | 'labour_added'
  | 'travel_added'
  | 'part_added'
  /**
   * A LABOUR, TRAVEL OR PARTS LINE TAKEN OFF A JOB. AUDIT-3.
   *
   * Its own type, and not a second `labour_added` with different wording,
   * because this is the one edit that takes money OFF what the customer is
   * asked to pay. Until this existed a Coordinator could delete a three-hour
   * labour line and nothing anywhere recorded that it had ever been there —
   * which is precisely the question an invoice dispute asks six months later.
   *
   * It carries the removed line's values as `changes`, each going to null, so
   * the trail says what was taken away and not merely that something was.
   */
  | 'line_item_removed'
  /**
   * THE CALL-OUT FEE APPLIED OR REMOVED. AUDIT-3.
   *
   * Whether a call-out is charged is a commercial decision per job
   * (COST-CALLOUT), so it is a fixed sum appearing on or disappearing from the
   * customer's document at somebody's discretion. It recorded nothing at all
   * before this, in any job state.
   *
   * The event carries the flag moving, not an amount: the fee itself comes from
   * the charge-out rates and is frozen into the pricing snapshot at submission,
   * and inventing a figure here would put a second, unreconciled number in the
   * trail.
   */
  | 'callout_changed'
  | 'checklist_completed'
  | 'moved_to_awaiting_spares'
  | 'returned_to_in_progress'
  | 'completion_started'
  /** The write-up the customer signs for: fault findings, work performed. */
  | 'completion_report_saved'
  | 'customer_signed'
  /** The customer would not sign, and why. The other outcome of that stage. */
  | 'customer_refused_to_sign'
  /** The office resolved the refusal, which is what releases the job card. */
  | 'signature_refusal_resolved'
  /** A corrected job card went back to the customer to be signed again. */
  | 'returned_for_customer_signature'
  /** The office corrected a job card the technician had already submitted. */
  | 'job_card_corrected'
  /** Who is collecting, which decides whether the document carries prices. */
  | 'collection_method_set'
  | 'pdf_generated'
  | 'job_submitted'
  /**
   * THE OFFICE SUBMITTED A SIGNED JOB CARD FOR AN UNAVAILABLE TECHNICIAN.
   * MASTER SCOPE CR-08.
   *
   * Its own type so the two are never confused when the trail is read: an
   * ordinary `job_submitted` is the technician's own last act, and this is the
   * office stepping in because that technician could not. It carries who took
   * over, whose job it was, and the unavailability that permitted it.
   */
  | 'submission_taken_over'
  /**
   * A change in what became of the customer's copy.
   *
   * Every attempt and every state change is recorded, so "we sent it" can be
   * checked against what the provider actually reported.
   */
  | 'delivery_state_changed'
  | 'master_amended_after_signature'
  | 'job_closed'
  | 'document_viewed'
  // Record administration. These carry no job id: they describe changes to the
  // customer, machine, user, library and checklist registers.
  | 'customer_created'
  | 'customer_updated'
  | 'site_created'
  | 'site_updated'
  // Removal is recorded either way it goes: a record nothing refers to is
  // deleted outright, one with job history is archived so those jobs still
  // resolve it. The two are different events because they are different facts.
  | 'site_deleted'
  | 'site_archived'
  | 'contact_created'
  | 'contact_updated'
  | 'contact_deleted'
  | 'contact_archived'
  | 'machine_created'
  | 'machine_approved'
  | 'machine_updated'
  /**
   * A photograph was attached to a machine. BD-14, MACH-PHOTO-2.
   *
   * Its own type rather than a second `machine_updated`, because the record did
   * NOT change — and an audit line claiming it did would be the same kind of
   * lie the simulated photographs used to tell about the files. Where a
   * technician photographed an OFFICIAL machine, the event is written against
   * the job that authorised it, so the photograph is traceable to the work.
   */
  | 'machine_photographed'
  /**
   * A capture the tablet held was refused by the server and referred to the
   * office. BD-15.
   *
   * Written against the JOB, because that is where somebody reading the trail
   * will be looking: "three hours were captured for this job on the 17th and
   * the job would not take them" is part of this job's history even though no
   * line was ever added to it.
   */
  | 'capture_referred'
  /** The office decided what happens to a referred capture. BD-15. */
  | 'capture_referral_resolved'
  | 'machine_deleted'
  | 'machine_archived'
  | 'user_created'
  | 'user_updated'
  /** A permission change: who changed it, whose it was, and from what to what. */
  | 'user_role_changed'
  | 'user_disabled'
  | 'user_reactivated'
  | 'password_reset_sent'
  /** Charge-out rates, travel, call-out or VAT changed. Masters only. */
  | 'settings_updated'
  | 'document_added'
  | 'document_updated'
  | 'document_versioned'
  | 'document_approved'
  | 'document_archived'
  /**
   * Whether an uploaded document's text could be read. LIB-5.
   *
   * On the trail because an index is a CLAIM about what the library can find.
   * A scanned manual that arrived unsearchable with nothing said about it is
   * how "we have no manual for that machine" gets said in good faith and is
   * wrong; this event carries which of the three outcomes it was and why.
   */
  | 'document_indexed'
  | 'checklist_template_created'
  | 'checklist_template_updated'
  | 'checklist_template_versioned'
  | 'checklist_template_archived'
  // Availability, messaging, transfer and the two ways a job can leave the
  // active workflow.
  | 'availability_created'
  | 'availability_updated'
  | 'availability_cancelled'
  | 'message_sent'
  | 'message_actioned'
  | 'job_transferred_to_open'
  | 'job_transferred_to_technician'
  | 'job_cancelled'
  | 'job_deleted'
  /**
   * A deletion that was recorded and then did not complete.
   *
   * Deletion writes its audit event first, so the evidence survives whatever
   * happens next. When the destructive step then fails, this says so — because
   * a trail that records a deletion which did not happen is worse than no trail.
   */
  | 'job_deletion_failed'
  /* ---- authentication. Who got in, who did not, and who was turned out ---- */
  /** A successful sign-in. */
  | 'user_signed_in'
  /**
   * A sign-in that was refused.
   *
   * Recorded with the address that was tried and NOT with what was typed as a
   * password — a trail that captures a mistyped password captures a real one
   * sooner or later. Carries no actor when the address matches no account,
   * because nobody did it.
   */
  | 'user_sign_in_failed'
  /** An account locked after repeated failures. */
  | 'user_locked_out'
  | 'user_signed_out'
  /** Every live session for one person ended at once, e.g. on being disabled. */
  | 'user_sessions_revoked';

/**
 * A value an audit event can carry. AUDIT-2.
 *
 * Deliberately narrow. Cents stay numbers, an enum stays its own string, a flag
 * stays a boolean, and an absent value is null rather than an empty string —
 * "no call-out fee" and "a call-out fee of nothing" are different facts. Dates
 * and money are NOT pre-formatted here: a trail that stored "R1 850,00" could
 * never be compared, totalled or re-rendered in another currency, and the
 * formatting belongs to whoever displays it.
 */
export type AuditValue = string | number | boolean | null;

/**
 * One field that changed, and what it changed from. AUDIT-2.
 *
 * `field` is a STABLE IDENTIFIER, not a label — `labour.hours`, not "Hours" —
 * because the trail outlives the wording on any screen, and a renamed heading
 * must not orphan the history that used it.
 */
export interface FieldChange {
  readonly field: string;
  readonly from: AuditValue;
  readonly to: AuditValue;
}

export interface ActivityEvent {
  readonly id: ActivityId;
  readonly jobId: JobId | null;
  readonly type: ActivityEventType;
  /** Human-readable summary, resolved at write time so the timeline is stable. */
  readonly summary: string;
  readonly detail: string;
  readonly actorId: UserId;
  readonly occurredAt: IsoDateTime;
  /**
   * What changed, structured. AUDIT-2.
   *
   * Empty for the great majority of events, which record that something
   * HAPPENED rather than that a value moved: a job accepted, a document
   * generated, a signature captured. It is populated where an existing recorded
   * value was replaced and the old one would otherwise be lost — an amended
   * labour line, a corrected part quantity, a charge-out rate.
   *
   * It does NOT replace `summary` and `detail`. Those stay the record a person
   * reads; this is the record a dispute can be settled from, and the two are
   * written together so they can never disagree.
   */
  readonly changes: readonly FieldChange[];
}
