/**
 * WHAT MAY BE CAPTURED WITH NO SIGNAL, AND WHAT MAY NOT. OFF-2, OFF-8, OFF-9.
 * CR-09 Phase 4, step one.
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
export type OfflineAction = 'add_labour' | 'add_travel' | 'add_part' | 'add_note';

export const OFFLINE_ACTIONS: readonly OfflineAction[] = [
  'add_labour',
  'add_travel',
  'add_part',
  'add_note',
];

export const isOfflineAction = (action: string): action is OfflineAction =>
  (OFFLINE_ACTIONS as readonly string[]).includes(action);

/**
 * The refusals, with the reason each one is a refusal.
 *
 * Data rather than prose so a screen can say WHY something needs a connection,
 * and so a test can assert that nothing has quietly joined the allowed list.
 */
export const ONLINE_ONLY: Readonly<Record<string, string>> = {
  answer_checklist:
    'A checklist answer replaces the previous one, and completing the checklist is checked against the template. Both need a connection.',
  complete_checklist: 'Completing the checklist is checked against the template on the server.',
  add_checklist_photo: 'A photograph has to be uploaded, which needs a connection.',
  save_report:
    'The completion report replaces what is on the server, so it cannot be written offline.',
  set_callout: 'The call-out flag replaces a value on the job, so it needs a connection.',
  set_collection: 'The collection method replaces a value on the job, so it needs a connection.',
  set_media_visibility: 'Reclassifying a photograph changes a stored value, so it needs a connection.',
  add_media: 'A photograph has to be uploaded, which needs a connection.',
  remove_media: 'Removing a photograph changes the record on the server.',
  capture_signature: 'A customer signature is only ever taken with a connection.',
  record_signature_refusal: 'A signature refusal is only ever recorded with a connection.',
  accept: 'Accepting a job moves it through the workflow, which the server decides.',
  start_completion: 'Moving the job on is a workflow step the server decides.',
  issue: 'Submitting the job card is a workflow step the server decides.',
  awaiting_spares: 'Putting a job on hold is a workflow step the server decides.',
  update_labour: 'Changing a captured line replaces it, so it needs a connection.',
  remove_labour: 'Removing a captured line changes the record on the server.',
  update_travel: 'Changing a captured line replaces it, so it needs a connection.',
  remove_travel: 'Removing a captured line changes the record on the server.',
  update_part: 'Changing a captured line replaces it, so it needs a connection.',
  remove_part: 'Removing a captured line changes the record on the server.',
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
