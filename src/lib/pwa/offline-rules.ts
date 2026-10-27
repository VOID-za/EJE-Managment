/**
 * WHAT MAY BE CAPTURED WITH NO SIGNAL, AND WHAT MAY NOT. OFF-2, OFF-8, OFF-9,
 * OFF-CHK-1. CR-09 Phase 4, steps one and two.
 *
 * THE RULE THIS FILE EXISTS TO MAKE EXPLICIT. A job card is a document a
 * customer signs and a business invoices from. Phase 3 refused every offline
 * write, which was honest but left a technician in a plant basement unable to
 * write down the hours they had just worked. This allows exactly one shape of
 * offline write and refuses every other, and the distinction is not about
 * convenience — it is about what the server can still be the authority on when
 * the work arrives late.
 *
 * WHAT IS ALLOWED: APPEND-ONLY LINE ITEMS. Labour, travel, parts and notes are
 * new rows. Replaying one later adds a row; it cannot erase or contradict
 * anything the office did in the meantime, so there is no merge to get wrong
 * and nothing of the server's to overwrite. The server still decides whether
 * the row may be added at all — `assertEditable` and `assertCanCapture` run on
 * the replay exactly as they do online, which is what makes a job that was
 * signed, closed, cancelled or reassigned while the tablet was away refuse the
 * work rather than absorb it.
 *
 * AND ONE ANSWER THAT IS NOT APPEND-ONLY: A CHECKLIST ITEM. OFF-CHK-1, added
 * once there was an answer to OFF-9. A service or installation checklist is
 * the body of the work, and refusing it offline meant a technician in a plant
 * basement either wrote the readings on their hand or did the job twice.
 *
 * It is allowed because the capture is no longer a bare instruction to
 * overwrite. It names the checklist INSTANCE it was answered on — the template
 * and the version — and the answer it is replacing, as the stamp the tablet
 * last saw. The server refuses it if either has moved (`ChecklistExpectation`
 * in `job-operations.ts`), so a stale answer is retained and referred to the
 * office rather than silently erasing somebody else's. That is the conflict
 * rule OFF-9 asked for, and nothing else was widened to get it: COMPLETING a
 * checklist and attaching EVIDENCE to one stay online-only below.
 *
 * The validation a held answer must satisfy is the template's own, applied
 * before it is held: an answer with no value is not held, and a failure with
 * no note is not held. The tablet has the template in memory because the
 * technician is looking at it — nothing is cached, inferred or fabricated.
 *
 * WHAT IS REFUSED, and why each one is a different kind of problem:
 *
 *   - ANYTHING THAT SETS A FIELD. The completion report, the call-out flag, the
 *     collection method and a photograph's classification all replace a value.
 *     Replaying one would overwrite whatever the office or another technician
 *     put there while the tablet was offline — the silent overwrite CR-02
 *     forbids outright.
 *   - THE CHECKLIST. An answer is per-item and replaces the previous answer,
 *     and completing it is a gate the server evaluates against the template.
 *     Both need a conflict rule that does not exist yet (OFF-9).
 *   - SIGNATURES AND REFUSALS. OFF-5, and the most consequential record in the
 *     system. A signature captured offline raises questions nobody has
 *     answered: what the customer was shown, what it means if the job changed
 *     between the signature and its arrival, and whether an unsent signature is
 *     a signature at all.
 *   - STATUS TRANSITIONS. Accepting, completing, submitting and taking over are
 *     the state machine, and two devices disagreeing about where a job has got
 *     to is not something a queue can settle.
 *   - MEDIA AND DOCUMENTS. Bytes, not fields (OFF-12). A photograph queued
 *     offline is megabytes held on a device with no agreed retention rule, and
 *     the upload path is a different mechanism from this queue entirely.
 *
 * Every one of those stays online-only, is listed below with its reason, and is
 * reported to the technician as not possible rather than accepted and dropped.
 */
import type { JobStatus } from '@/domain';

/** The actions this device may hold on behalf of the server. */
export type OfflineAction =
  | 'add_labour'
  | 'add_travel'
  | 'add_part'
  | 'add_note'
  | 'answer_checklist'
  | 'capture_signature_offline'
  | 'record_refusal_offline';

export const OFFLINE_ACTIONS: readonly OfflineAction[] = [
  'add_labour',
  'add_travel',
  'add_part',
  'add_note',
  'answer_checklist',
  'capture_signature_offline',
  'record_refusal_offline',
];

/**
 * THE CUSTOMER'S SIGNATURE AND REFUSAL, HELD. BD-23 — approved by the owner on
 * 27 October 2026, and the end of the "signatures and refusals" refusal below.
 *
 * Not the online commands made holdable: two commands of their own, because
 * what they carry is different. Each names the document the customer was shown
 * by its identity (`document-identity.ts`), and the server accepts it only if
 * its own recomputation of that document is identical; otherwise nothing on the
 * job changes and the capture is referred to the office with its evidence
 * (`offline-signature.ts`). The online `capture_signature` and
 * `record_refusal` stay online-only and unchanged.
 */
export const OFFLINE_SIGNATURE_ACTIONS: readonly OfflineAction[] = [
  'capture_signature_offline',
  'record_refusal_offline',
];

export const isOfflineSignatureAction = (action: string): boolean =>
  (OFFLINE_SIGNATURE_ACTIONS as readonly string[]).includes(action);

/**
 * Whether the office may APPLY a referred capture of this action. BD-15, BD-23.
 *
 * Not a held signature or refusal: applying one would put the customer's mark
 * on a document they were not shown. The office has the current document
 * signed in the ordinary way and closes the referral with a reason.
 */
export const isReferralApplicable = (action: string): boolean =>
  isOfflineAction(action) && !isOfflineSignatureAction(action);

export const isOfflineAction = (action: string): action is OfflineAction =>
  (OFFLINE_ACTIONS as readonly string[]).includes(action);

/**
 * The refusals, with the reason each one is a refusal.
 *
 * Data rather than prose so a screen can say WHY something needs a connection,
 * and so a test can assert that nothing has quietly joined the allowed list.
 *
 * TWO OF THESE ARE NOW "NOT HERE" RATHER THAN "NOT POSSIBLE": a photograph is
 * held by the media queue (OFF-MEDIA-1), which is a different mechanism with
 * its own store, its own ceiling and its own flush — not a member of this
 * queue's allowlist. Their reasons say so.
 *
 * *Amended 18 October 2026.* THIS MAP HAD DRIFTED FROM THE SERVER. It explained
 * three commands that no longer exist under those names (`add_media` and
 * `add_checklist_photo` became multipart routes, `record_signature_refusal`
 * became `record_refusal`, the three `remove_*` line commands became
 * `remove_line`) and said nothing at all about twenty-one that do — every
 * transfer, the cancellation, the deletion, the delivery calls, the refusal
 * resolution, the technician assignments. Each of those fell through to "This
 * needs a connection to the EJE server", the one sentence that is true of
 * everything and useful for nothing. `offline-inventory.test.ts` now compares
 * this map with the real command registry, so a command added to the server
 * without an offline answer fails a test by name.
 */
/**
 * ACTIONS A TABLET CAN ATTEMPT THAT ARE NOT JSON JOB COMMANDS.
 *
 * Both are photographs, and both arrive as multipart bytes at their own route
 * rather than through the command registry — so the registry cannot be the only
 * thing this map is checked against. Declared here, by name, so the comparison
 * in `offline-inventory.test.ts` can tell a legitimate non-command from an
 * entry that has gone stale because somebody renamed a command.
 */
export const NON_COMMAND_FIELD_ACTIONS: readonly string[] = [
  'add_media',
  'add_checklist_photo',
];

export const ONLINE_ONLY: Readonly<Record<string, string>> = {
  complete_checklist: 'Completing the checklist is checked against the template on the server.',
  start_checklist: 'Starting the checklist takes the current wording from the server.',
  /*
   * BYTES ARE NOT A QUEUED REQUEST, and that is still true — but they are no
   * longer lost. OFF-MEDIA-1: a photograph taken with no signal is kept in its
   * own store with its own flush (`pending-media.ts`), because this queue
   * carries JSON bodies and a 2 MB file is not one. So the ANSWER to the
   * checklist question goes here and the PHOTOGRAPH goes there, both saying
   * they are on the tablet rather than on the job.
   */
  add_checklist_photo:
    'A photograph is not sent with the other captures. It is kept on this tablet and uploaded on its own when there is a signal.',
  save_report:
    'The completion report replaces what is on the server, so it cannot be written offline.',
  set_callout: 'The call-out flag replaces a value on the job, so it needs a connection.',
  set_test_bench: 'The test bench fee replaces a value on the job, so it needs a connection.',
  /*
   * COST-5. CHARGES AND DISCOUNTS ARE OFFICE WORK, NOT FIELD CAPTURE.
   *
   * The queue exists for work a technician cannot otherwise record — hours at
   * a machine with no signal. These four are decided at a desk: a charge is
   * priced against something the office is holding an invoice for, and a
   * discount is a Master's commercial decision whose figure is checked against
   * the job as the SERVER has it. Holding either on a tablet would mean
   * deciding what happens when the job moved underneath it, which is the
   * reason amending any line is online-only too (OFF-9).
   */
  /*
   * DRAFT-1. A technician never sees a draft at all, so this reason is for
   * completeness rather than for a screen: the inventory test requires every
   * command to declare a posture, and declaring it is how a command that
   * SHOULD be holdable cannot be forgotten.
   */
  release_draft:
    'Releasing a draft is a Master’s act in the office, and it re-checks the register on the server.',
  /*
   * JOB-EDIT-1. Office work, never held: the edit carries the values it
   * replaces and is refused if the job moved underneath it — a held edit
   * replayed hours later is exactly the overwrite that check exists to stop.
   */
  edit_details:
    'Correcting a job’s details replaces values on the job, and is checked against the job as the server has it, so it needs a connection.',
  add_additional_charge:
    'A charge is added by the office against what it is being charged for, so it needs a connection.',
  update_additional_charge:
    'Changing a charge replaces a value on the job, so it needs a connection.',
  set_collection: 'The collection method replaces a value on the job, so it needs a connection.',
  set_media_visibility: 'Reclassifying a photograph changes a stored value, so it needs a connection.',
  add_media:
    'A photograph is not sent with the other captures. It is kept on this tablet and uploaded on its own when there is a signal.',
  remove_media: 'Removing a photograph changes the record on the server.',
  capture_signature:
    'This is the signature taken with a connection. With no signal the tablet holds it as an offline signature instead, tied to the document the customer was shown.',
  start_signature: 'Taking a customer signature needs a connection from the first step.',
  record_refusal:
    'This is the refusal recorded with a connection. With no signal the tablet holds it as an offline refusal instead, tied to the document the customer was shown.',
  resolve_refusal:
    'What happens after a customer refuses to sign is the office’s decision, recorded on the server.',
  accept: 'Accepting a job moves it through the workflow, which the server decides.',
  decline_site_location: 'Telling the office you do not need the site location needs a connection.',
  send_site_location: 'The site location goes out through WhatsApp, which needs a connection.',
  start_completion: 'Moving the job on is a workflow step the server decides.',
  cancel_completion: 'Going back to In Progress is a workflow step the server decides.',
  return_to_progress: 'Reopening the job is a workflow step the server decides.',
  return_for_signature: 'Sending the job back for a signature is a workflow step the server decides.',
  issue: 'Submitting the job card is a workflow step the server decides.',
  take_over_submission:
    'Submitting a job card on somebody else’s behalf is an office step the server decides.',
  generate_document: 'The job card is rendered on the server, from what the server holds.',
  confirm_delivery:
    'Whether the customer received their copy is something only the mail provider can answer.',
  retry_delivery: 'Sending the customer their copy again needs a connection to the mail provider.',
  // The office lifecycle (issue #73): office steps on the server, never held.
  handle_office: 'Marking a job card handled is an office step the server decides.',
  record_invoice:
    'An invoice number is recorded once, against the job as the server has it, so it needs a connection.',
  /*
   * CORRECTING AN ISSUED JOB CARD, AND SENDING AN UNSIGNED ONE. BD-02, BD-06.
   *
   * All four are office decisions taken on an issued document, and none of
   * them is a capture a technician makes at a machine — so the honest reason
   * is not "no connection" but "this is not yours and not here". A technician
   * who somehow reached one of these would be shown the sentence below, and
   * the server would refuse them anyway (`jobs.raiseCorrection` and
   * `jobs.authoriseUnsignedDelivery` are a Master's).
   */
  raise_correction:
    'Correcting a job card EJE have already issued is a Master’s decision, taken in the office with the original document to hand.',
  acknowledge_correction:
    'Recording that the customer acknowledged a correction is office work on the server’s record.',
  authorise_unsigned_delivery:
    'Sending a customer a job card they declined to sign is a Master’s decision and goes out through the mail provider.',
  retry_unsigned_delivery:
    'Re-sending an unsigned job card needs a connection to the mail provider.',
  awaiting_spares: 'Putting a job on hold is a workflow step the server decides.',
  reschedule:
    'Changing the date moves the job in the calendar everybody shares, so it needs a connection.',
  cancel: 'Cancelling a job is an office decision recorded on the server.',
  delete: 'Deleting a job is an office action, and never one taken from a tablet.',
  assign_primary: 'Who owns a job is decided by the office on the server.',
  add_technician: 'Adding somebody to a job changes who may work on it, which the office decides.',
  remove_technician:
    'Taking somebody off a job changes who may work on it, which the office decides.',
  transfer_to_technician: 'Reassigning a job is an office decision recorded on the server.',
  transfer_to_open: 'Putting a job back on the open list is an office decision.',
  update_labour: 'Changing a captured line replaces it, so it needs a connection.',
  update_travel: 'Changing a captured line replaces it, so it needs a connection.',
  update_part: 'Changing a captured line replaces it, so it needs a connection.',
  remove_line: 'Removing a captured line changes the record on the server.',
};

/**
 * What this device believed about the job when the work was captured.
 *
 * NOT a concurrency token and never presented as one — the server holds no
 * client-visible version for a job, and inventing one here would be inventing
 * a protocol. This is the capture CONTEXT, and it has two honest uses: to
 * refuse capture against a job the device already knows is not capturable, and
 * to explain to a technician afterwards what changed underneath them.
 *
 * The authority on whether the work may be applied is the server, on the
 * replay. This only ever narrows what gets as far as being queued.
 */
export interface CaptureContext {
  readonly status: JobStatus;
  /** Whether the signed-in technician was on the job when it was cached. */
  readonly mine: boolean;
  /** Whether the customer had already signed. */
  readonly signed: boolean;
  /** When this device last heard any of the above from the server. */
  readonly observedAt: string;
}

/**
 * The statuses a technician may capture work against with no signal.
 *
 * `in_progress` only. Not `open` (the job has not been accepted, and accepting
 * is a workflow step), not `completion` or beyond (the write-up has started and
 * the office may be reviewing), not `awaiting_spares` (the job is on hold and
 * resuming it is a transition). The narrow set is deliberate: every status
 * outside it has a workflow question attached, and a queue cannot answer one.
 */
export const OFFLINE_CAPTURE_STATUSES: readonly JobStatus[] = ['in_progress'];

/**
 * The one status a held signature or refusal may be taken at. BD-23.
 *
 * Customer Signature, which the job reaches through the ordinary online step
 * (`start_signature`) — moving the job there is still a transition the server
 * decides. The signature itself is then the only thing held.
 */
export const OFFLINE_SIGNATURE_STATUSES: readonly JobStatus[] = ['customer_signature'];

export interface CaptureVerdict {
  readonly allowed: boolean;
  /** What the technician is told, when it is not allowed. */
  readonly reason: string | null;
}

/**
 * Whether this device may hold work for this job at all.
 *
 * Deliberately pessimistic, and in this order: a signed job is final (CR-01,
 * IMMUT-1…7) whatever else is true; a job that is not this technician's is not
 * theirs to capture against; and a job that has moved on needs the server.
 */
export const canCaptureOffline = (
  action: string,
  context: CaptureContext,
): CaptureVerdict => {
  if (!isOfflineAction(action)) {
    return {
      allowed: false,
      reason:
        ONLINE_ONLY[action] ??
        'This needs a connection to the EJE server, so it cannot be done offline.',
    };
  }
  if (context.signed) {
    return {
      allowed: false,
      reason: 'The customer has signed this job card, so nothing further can be captured on it.',
    };
  }
  if (!context.mine) {
    return {
      allowed: false,
      reason: 'This job is not assigned to you, so work cannot be captured on it offline.',
    };
  }
  if (isOfflineSignatureAction(action)) {
    return OFFLINE_SIGNATURE_STATUSES.includes(context.status)
      ? { allowed: true, reason: null }
      : {
          allowed: false,
          reason:
            'This job was not waiting for the customer’s signature on this tablet’s last copy, so a signature cannot be held for it.',
        };
  }
  if (!OFFLINE_CAPTURE_STATUSES.includes(context.status)) {
    return {
      allowed: false,
      reason:
        'This job is not in progress on this tablet’s last copy, so capturing against it needs a connection.',
    };
  }
  return { allowed: true, reason: null };
};

/**
 * How a server refusal of queued work is classified. OFF-9, BD-15, BD-16.
 *
 * `retry` — nothing was decided. The request did not arrive, or the server had
 * a fault, so the work stays queued exactly as it was.
 *
 * `blocked` — the server would not even consider it, because there is no
 * session. *Added 18 October 2026 for BD-16, and it is a defect fix:* a 401
 * used to be classified as a conflict, which meant a technician whose session
 * expired mid-flush had their captures marked as refused by the server and
 * referred to the office — when in fact the server had said nothing about them
 * at all. The work now stays queued, untouched, and the flush stops: the
 * remedy is signing in again, not an office decision.
 *
 * `conflict` — the server considered it and said no, and saying it again will
 * not help: the job was signed, closed, cancelled or reassigned, this actor may
 * no longer touch it, or the details are not valid. A person has to decide what
 * happens to that capture, which is why it is never retried automatically and
 * never discarded on the technician's behalf (OFF-9, CR-02). Under BD-15 it is
 * referred to the office.
 */
export type RefusalKind = 'conflict' | 'retry' | 'blocked';

export const classifyRefusal = (code: string | null): RefusalKind => {
  switch (code) {
    case 'network':
    case 'internal_error':
    case 'rate_limited':
    case null:
      return 'retry';
    case 'unauthenticated':
      /*
       * THE SESSION, NOT THE CAPTURE. A revoked or expired session is a fact
       * about who is holding the tablet, and the work it is holding is still
       * perfectly good — see BD-16, which is why this is its own kind.
       */
      return 'blocked';
    default:
      /*
       * Everything else is the server having decided: 403 (not this actor's to
       * do), 422 (the workflow refuses it), 409 (somebody wrote first), 404
       * (the job is no longer visible to them).
       */
      return 'conflict';
  }
};
