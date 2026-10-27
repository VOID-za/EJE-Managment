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
   * COST-5. A charge that is not labour, travel or a part.
   *
   * Its own types rather than another `part_added`, for the reason the removal
   * and the amendment already have their own: the office filtering for "why is
   * this invoice higher" needs to see a charge as a charge, and a charge going
   * ON is a different question from one being CHANGED.
   */
  | 'additional_charge_added'
  | 'additional_charge_amended'
  /**
   * COST-5. Money off the whole job, and who authorised it.
   *
   * Four types, because four different things happen and each is asked about
   * separately: a discount was agreed, the figure was changed, it was taken off
   * again — and all three are a Master's act, which is the point of recording
   * them apart from the work.
   */
  | 'discount_applied'
  | 'discount_amended'
  | 'discount_removed'
  /**
   * A BULK READ OF EJE'S OWN DATA. BD-18.
   *
   * The first READ on a trail where every other event is a CHANGE, and that
   * is exactly why whether to write it is EJE's decision rather than ours —
   * adding one kind of read makes the trail's silence about every other read
   * significant in a way it was not before.
   *
   * The type exists so that answering BD-18 needs no release: the write is
   * built and switched off behind `EJE_EXPORT_AUDIT`, and a type nobody emits
   * costs nothing. `audit_events.type` is `text`, so no migration either.
   */
  | 'data_exported'
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
  /**
   * The office corrected a job's RECORDED DETAILS before signature. JOB-EDIT-1.
   *
   * The order number, reference, delivery note, quote number, fault
   * description or the unit booked in — each moved field carried as a
   * `details.<field>` from/to pair (AUDIT-2). Its own type, not
   * `job_card_corrected`: that one is the refusal workflow's edit of submitted
   * work, and this one can happen on any editable job, so a reader filtering
   * for either must not get both.
   */
  | 'job_details_edited'
  /**
   * A correction was raised against a job card EJE HAVE ALREADY ISSUED. BD-02.
   *
   * Its own type, and not `job_card_corrected`, because the two are opposite
   * acts: that one is the office editing a draft before it goes out, and this
   * one is EJE saying that a document the customer already holds is wrong.
   * Nothing is edited here — a new record and a new addendum are added — and
   * an audit trail that called both "corrected" would make the distinction
   * unrecoverable.
   */
  | 'job_correction_raised'
  /** The customer confirmed they had seen a correction. BD-02. */
  | 'job_correction_acknowledged'
  /**
   * A Master authorised sending a job card the customer DECLINED to sign.
   * BD-06, AUD-4.
   *
   * Its own type and not `delivery_state_changed`, because it is a DECISION
   * rather than an event: somebody will be asked who authorised sending a
   * document to a customer who refused to put their name to it, and the answer
   * must not be buried among the provider's attempts. The attempts themselves
   * are still `delivery_state_changed`, as every other send is.
   */
  | 'unsigned_delivery_authorised'
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
  /** The office handled a submitted job card: Office Handling -> Awaiting PO. Issue #73. */
  | 'job_office_handled'
  /** The office recorded the invoice number: Awaiting PO -> Invoiced. Issue #73. */
  | 'job_invoiced'
  | 'document_viewed'
  // Record administration. These carry no job id: they describe changes to the
  // customer, machine, user, library and checklist registers.
  | 'customer_created'
  | 'customer_updated'
  /*
   * SOMEBODY WHO MAY NOT EDIT THE REGISTER SAYS IT IS WRONG, and what the
   * office did about it. CUST-CR.
   *
   * Two types rather than one, because they are two different facts and the
   * second does not always follow the first: a report can sit open for a week,
   * and the trail has to show that as plainly as it shows the decision.
   *
   * NEITHER OF THEM IS A CHANGE TO THE REGISTER. `customer_change_resolved`
   * records that the office DECIDED; the edit itself, if they made one, arrives
   * as an ordinary `customer_updated` or `machine_updated` with its own
   * before-and-after values. Collapsing the two would make the trail claim a
   * change that the system never performed — see
   * `src/application/change-request-operations.ts` for why it performs none.
   */
  | 'customer_change_requested'
  | 'customer_change_resolved'
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
  /**
   * The attendance register (ATTEND-1): a day recorded for somebody for the
   * first time, and a recorded day corrected — the second carries what it said
   * before, which is the register's history.
   */
  | 'attendance_recorded'
  | 'attendance_corrected'
  /** A technician's daily timesheet comment written, changed or cleared. TIMESHEET-1. */
  | 'timesheet_comment_saved'
  /** A technician added, corrected or removed a line of their own timesheet. TIMESHEET-2. */
  | 'timesheet_entry_added'
  | 'timesheet_entry_corrected'
  | 'timesheet_entry_removed'
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
