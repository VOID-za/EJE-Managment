import type { IsoDate, UserId } from '../types/common';
import type { AvailabilityRecord, AvailabilityType } from '../types/availability';
import { isBlockingAvailability } from '../types/availability';
import type { Job, JobStatus } from '../types/job';
import type { User, UserRole } from '../types/user';
import { can } from '../access';
import { getJobTypeDefinition } from './job-types';
import { checkCollectionDetails } from './parts-document';

/**
 * The job workflow state machine.
 *
 * This module is the single source of truth for which transitions are legal and
 * why a transition is blocked. The UI asks it questions; it never re-implements
 * the rules. That is what makes the demo safe to grow into the production
 * system: the same machine will sit behind the REST API.
 */

/**
 * The statuses a person can pick from, in workflow order.
 *
 * `submitted` is deliberately absent: Master Review is retired, nothing can
 * enter it, and offering it as a filter would present a stage of the system
 * that no longer exists. The few historical jobs still in it are shown — and
 * filtered — as Review, which is the stage they actually reached; see
 * `jobStatusLabel` and `statusMatches`.
 */
export const JOB_STATUS_ORDER: readonly JobStatus[] = [
  'draft',
  'open',
  'in_progress',
  'awaiting_spares',
  'completion',
  'customer_signature',
  'review',
  'awaiting_delivery',
  'closed',
  'cancelled',
];

/**
 * The stages shown on the job card's progress rail: the ACTIVE workflow.
 *
 * Six stages, and `submitted` is deliberately not one of them. That status is
 * the retired Master Review stage — no new job can reach it, since a
 * technician's submission issues the job card itself — so listing it here drew
 * a seventh step labelled "Master Review" on every job, including jobs that
 * could never go there. The rail is what the workflow IS, not what it once was.
 *
 * Statuses that are not stages are placed onto the rail by
 * `jobProgressPosition` rather than being added to it: awaiting spares and
 * awaiting delivery are interruptions of a stage, and a job left in the retired
 * stage sits at the stage it had actually reached.
 */
export const JOB_PROGRESS_STAGES: readonly JobStatus[] = [
  'open',
  'in_progress',
  'completion',
  'customer_signature',
  'review',
  'closed',
];

export interface JobProgressPosition {
  /** Index into `JOB_PROGRESS_STAGES`, or -1 for a job outside the rail. */
  readonly index: number;
  /**
   * What to show in place of the stage's own name, when the job is held at
   * that stage by something that is not a stage of its own. Null otherwise.
   */
  readonly interruption: string | null;
}

/**
 * Where a job sits on the six-stage rail.
 *
 * Every status maps onto a stage, because a job always has a position even
 * when its status is not itself a step: spares and delivery hold a job AT a
 * stage rather than adding one, and a job still in the retired Master Review
 * stage is shown where it genuinely got to — at Review — and labelled as the
 * historical state it is, so those records stay readable without Master Review
 * reappearing as a step of the live workflow.
 */
export const jobProgressPosition = (status: JobStatus): JobProgressPosition => {
  const at = (stage: JobStatus, interruption: string | null = null): JobProgressPosition => ({
    index: JOB_PROGRESS_STAGES.indexOf(stage),
    interruption,
  });

  switch (status) {
    case 'awaiting_spares':
      return at('in_progress', 'Awaiting Spares');
    // Issued: the customer's copy is in transit, so the work is done but the
    // job is not closed. It waits at Review rather than pretending to be shut.
    case 'awaiting_delivery':
      return at('review', 'Awaiting Delivery');
    /*
     * Historical only, and shown simply as Review.
     *
     * It reached Review and stopped there; naming the retired stage on the
     * rail would put a step in front of the technician that the system no
     * longer has and they cannot act on.
     */
    case 'submitted':
      return at('review');
    case 'draft':
    case 'cancelled':
      return { index: -1, interruption: null };
    default:
      return at(status);
  }
};

const TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  draft: ['open', 'cancelled'],
  // A technician handing a job back returns it to Open, which is why the
  // reverse edge exists. It carries all the work already recorded with it.
  open: ['in_progress', 'cancelled'],
  // Awaiting spares may be entered and left any number of times.
  in_progress: ['awaiting_spares', 'completion', 'open'],
  awaiting_spares: ['in_progress', 'open'],
  // Handing back from the write-up stage is legitimate — a technician taken
  // ill before the customer signs should not have to abandon the job.
  completion: ['customer_signature', 'in_progress', 'awaiting_spares', 'open'],
  customer_signature: ['review', 'completion'],
  // A technician's submission issues the job card itself, so `review` goes
  // straight to awaiting delivery. There is deliberately NO edge to
  // `submitted`: Master Review is retired, and a stage nothing can enter is the
  // only kind that cannot quietly come back.
  //
  // The edge back to `customer_signature` is the correction loop: a customer
  // who refused is shown a corrected job card and asked again. It carries the
  // whole job with it — nothing is re-captured — and only the office may take
  // it; see `jobs.resubmitForSignature`.
  /*
   * `closed` IS AN EDGE FROM HERE, and it is the second refusal outcome.
   *
   * "WITHOUT CUSTOMER SIGNATURE — the refusal is resolved, the job is CLOSED
   * immediately. There must be NO subsequent Customer Signature step, NO Review
   * step after this, NO Capture Signature button." Acceptance testing found the
   * office resolving a refusal that way and the job carrying on displaying the
   * signature workflow, because resolving recorded the OUTCOME and moved
   * nothing: the job sat where it was with a Capture Signature button on it.
   *
   * It is deliberately NOT routed through `awaiting_delivery`. That state means
   * "a customer's copy is in transit and we are waiting on the provider", and
   * there is no copy to wait for — nobody signed, so nothing is issued. Closing
   * through a delivery handshake that will never arrive would leave the job
   * stuck for ever.
   */
  review: ['awaiting_delivery', 'customer_signature', 'completion', 'closed'],
  // Only a confirmed delivery closes a job. The self-edge is a retry.
  awaiting_delivery: ['closed', 'awaiting_delivery'],
  // Historical only. Nothing transitions INTO this state any more; the edges
  // out of it exist so a job that entered Master Review before it was retired
  // can still be issued and closed.
  submitted: ['awaiting_delivery', 'closed'],
  closed: [],
  // Terminal. A cancelled job is history, not something to resurrect: raise a
  // new job instead, so the record of what was cancelled stays intact.
  cancelled: [],
};

export const jobStatusLabel = (status: JobStatus): string => {
  switch (status) {
    case 'draft':
      return 'Draft';
    case 'open':
      return 'Open';
    case 'in_progress':
      return 'In Progress';
    case 'awaiting_spares':
      return 'Awaiting Spares';
    case 'completion':
      return 'Completion';
    case 'customer_signature':
      return 'Customer Signature';
    case 'review':
      return 'Review';
    case 'awaiting_delivery':
      // Issued and sent; waiting on the provider to confirm the customer
      // received it. Not closed, because nobody has confirmed they have it.
      return 'Awaiting Delivery';
    case 'submitted':
      /*
       * The retired Master Review stage.
       *
       * Shown as Review, which is where such a job actually got to: signed,
       * written up, waiting to be issued. Master Review is not a concept this
       * system has any more, so naming it here would put a stage in front of
       * users — in badges, filters, counts and tooltips — that they cannot
       * reach and cannot act on. The STATUS is untouched, so the historical
       * record is intact; only its presentation is current.
       */
      return 'Review';
    case 'closed':
      return 'Closed';
    case 'cancelled':
      return 'Cancelled';
  }
};

/**
 * Whether a job with this status belongs under this status filter.
 *
 * Exists so a historical `submitted` job is found under Review rather than
 * being unreachable: it is labelled Review, so it has to be listed there too.
 */
export const statusMatches = (status: JobStatus, filter: JobStatus): boolean =>
  status === filter || (filter === 'review' && status === 'submitted');

export const canTransition = (from: JobStatus, to: JobStatus): boolean =>
  TRANSITIONS[from].includes(to);

export const allowedTransitions = (from: JobStatus): readonly JobStatus[] => TRANSITIONS[from];

/**
 * Whether anyone at all may still change this job.
 *
 * A closed job is final, and so is one awaiting delivery: its job card has been
 * generated and sent, so changing the job would leave the record disagreeing
 * with the document the customer holds. A job still in the historical Master
 * Review stage has not been issued, so a Master can correct it — see
 * `canEditJob`, which is the check screens should use.
 */
export const isJobEditable = (status: JobStatus): boolean =>
  status !== 'closed' && status !== 'cancelled' && status !== 'awaiting_delivery';

/**
 * Whether THIS ROLE may edit a job in this state.
 *
 * Technicians work a job up to the point they hand it over. The office keeps
 * editing beyond it, which is what makes correcting a refused job card possible
 * at all; see `canAdministrativelyEdit`.
 */
export const canEditJob = (role: UserRole, status: JobStatus): boolean => {
  if (status === 'closed' || status === 'cancelled') return false;
  // Issued. The document is with the customer and the record must keep
  // matching it, whether or not delivery has been confirmed yet.
  if (status === 'awaiting_delivery') return false;
  if (status === 'submitted') return role === 'master';
  /*
   * THE JOB IS WITH THE OFFICE. THE TECHNICIAN IS READ-ONLY.
   *
   * "From that point onward the technician is READ-ONLY on that job… The
   * technician may ONLY view the submitted job card and its refusal
   * information."
   *
   * This returned true for every role, so a technician whose customer had
   * refused to sign was still offered — and still granted — edits on a job they
   * had already handed over. Handing it over is the point at which it stops
   * being theirs. The office keeps editing, because correcting a refused job
   * card is the whole of the refusal workflow.
   */
  if (status === 'review') return can(role, 'jobs.editSubmittedJob');
  return true;
};

/**
 * Whether this person may make the FINAL SUBMISSION of this job card. CR-07.
 *
 * The normal signed journey has no office step. The technician who accepted
 * the job, did the work and took the customer's signature submits it — that
 * one act generates the customer's copy, emails it and starts the delivery
 * handshake. A Master and a Coordinator are not offered it and are refused it,
 * on an ordinary job, however senior.
 *
 * TWO EXCEPTIONS, and both are about somebody who is NOT in a normal signed
 * journey:
 *
 * - A PARTS COLLECTION is handed over at the EJE counter, not on a customer's
 *   site. Whoever processed it issues it, which is `jobs.processParts` — the
 *   same exception, in the same shape, as `acceptJobRefusal` and
 *   `canAcceptJob` already carry.
 * - THE RETIRED MASTER REVIEW STAGE. Nothing can enter `submitted` any more,
 *   but jobs that entered it before it was retired still exist and still have
 *   to be able to leave. A Master can move those on, because otherwise they
 *   are stranded for ever and there is nobody else who could.
 *
 * The screen and the server ask this same function, so a button cannot be
 * offered that the operation would refuse.
 */
export const canSubmitJobCard = (
  actor: Pick<User, 'id' | 'role'>,
  job: Pick<Job, 'status' | 'jobType' | 'primaryTechnicianId' | 'additionalTechnicianIds'>,
): boolean => {
  if (job.jobType === 'parts') return can(actor.role, 'jobs.processParts');
  if (job.status === 'submitted') return actor.role === 'master';

  // The technician's own capability: the field holds it and the office does not.
  if (can(actor.role, 'jobs.issueFinal')) return true;

  /*
   * WHOEVER ACTUALLY ATTENDED THE MACHINE, whatever their role.
   *
   * A MASTER MAY ACCEPT FIELD WORK — `jobs.acceptField` is his, deliberately,
   * and only the Coordinator is kept out of it. So a Master can be the person
   * who drove out, did the work and took the customer's signature, and without
   * this he could not then submit his own job: the rule would have offered him
   * Accept and then refused him the last step of the thing he accepted.
   *
   * This is not a way back in for the office. It asks whether the person is ON
   * the job, which is the same question `acceptJobRefusal` asks, so it cannot
   * reach a job they did not attend — and the Coordinator cannot reach it at
   * all, because she cannot be on one.
   */
  return can(actor.role, 'jobs.acceptField') && isAssignedTo(job, actor.id);
};

/* -------------------------------------------------------------------------- *
 * THE EXCEPTIONAL TAKEOVER. MASTER SCOPE CR-08, resolving BD-09.
 * -------------------------------------------------------------------------- */

/** Why one person who could otherwise submit this job card cannot. */
export type SubmissionBlock =
  /** Their account has been disabled: they have left, or access was revoked. */
  | { readonly kind: 'account_disabled'; readonly userId: UserId }
  /** The office put a whole-day absence on the calendar covering today. */
  | {
      readonly kind: 'away';
      readonly userId: UserId;
      readonly absence: AvailabilityType;
      readonly from: IsoDate;
      readonly to: IsoDate;
    };

export interface SubmissionCover {
  /** People on the job who could submit it, and are here to do it. */
  readonly available: readonly UserId[];
  /** People on the job who could submit it, and cannot. */
  readonly blocked: readonly SubmissionBlock[];
  /** True when the job names nobody who could submit it at all. */
  readonly unassigned: boolean;
}

/**
 * A whole-day absence, on the calendar, covering this day.
 *
 * ALL-DAY ONLY, and that is the business rule rather than an implementation
 * convenience. A part-day record — the two-hour appointment the data models
 * separately with `startTime`/`endTime` — means the technician is at work
 * today and will pick the job up; it is not a reason for the office to take
 * their submission away from them. A whole day is.
 *
 * Cancelled records are ignored, because `isBlockingAvailability` says a
 * cancelled absence stops blocking, and this must agree with the calendar the
 * office is looking at.
 */
export const isAwayAllDayOn = (record: AvailabilityRecord, day: IsoDate): boolean =>
  isBlockingAvailability(record) &&
  record.allDay &&
  record.startDate <= day &&
  day <= record.endDate;

/**
 * WHO COULD SUBMIT THIS SIGNED JOB CARD TODAY, AND WHO CANNOT. CR-08.
 *
 * The whole of "the technician is unavailable", decided here, from data the
 * office already maintains:
 *
 *  - `User.active` — a disabled account. They have left EJE or their access
 *    was revoked, which is permanent and unambiguous.
 *  - The AVAILABILITY REGISTER — a whole-day absence covering today. Only a
 *    Master writes those, and the docblock on `AvailabilityRecord` says so:
 *    "A technician telling the office they have an appointment is a MESSAGE,
 *    not an availability record — the office decides what goes on the
 *    calendar." That is what makes it safe to hang a permission on.
 *
 * It asks about EVERYONE on the job who could submit it, not only the primary:
 * if a second technician who attended is at work, the job is not stuck and
 * there is nothing to rescue.
 *
 * WHAT IT DELIBERATELY DOES NOT MODEL is a technician who is at work but
 * cannot reach the system — a lost or broken tablet. There is no record of
 * that anywhere in the data, and inventing a flag for it would be exactly the
 * vague client-side condition this function exists to avoid. The office's
 * remedy there is to put the absence on the calendar, which is a deliberate,
 * audited act by a Master.
 */
export const submissionCover = (
  job: Pick<Job, 'status' | 'jobType' | 'primaryTechnicianId' | 'additionalTechnicianIds'>,
  people: readonly User[],
  absences: readonly AvailabilityRecord[],
  today: IsoDate,
): SubmissionCover => {
  const onTheJob = people.filter(
    (person) =>
      isAssignedTo(job, person.id) && canSubmitJobCard(person, { ...job, status: 'review' }),
  );

  if (onTheJob.length === 0) {
    return { available: [], blocked: [], unassigned: true };
  }

  const available: UserId[] = [];
  const blocked: SubmissionBlock[] = [];

  for (const person of onTheJob) {
    if (!person.active) {
      blocked.push({ kind: 'account_disabled', userId: person.id });
      continue;
    }
    const away = absences.find(
      (record) => record.userId === person.id && isAwayAllDayOn(record, today),
    );
    if (away !== undefined) {
      blocked.push({
        kind: 'away',
        userId: person.id,
        absence: away.type,
        from: away.startDate,
        to: away.endDate,
      });
      continue;
    }
    available.push(person.id);
  }

  return { available, blocked, unassigned: false };
};

/** Nobody who could submit this job card is here to do it. */
export const isSubmissionUncovered = (cover: SubmissionCover): boolean =>
  cover.available.length === 0;

/**
 * Whether this person may take the submission over. CR-08.
 *
 * FOUR THINGS AT ONCE, and every one of them is required:
 *
 *  1. They hold `jobs.takeOverSubmission` — the office, and nobody else.
 *  2. The job is SIGNED. A refused job card is not eligible and never will be:
 *     it has its own workflow, its own two outcomes and its own review, and
 *     merging the two would put the office review back into the signed journey
 *     by another name.
 *  3. The job is at `review`, which is where a signed, unsubmitted job card
 *     waits. Not closed, not already issued, not in the retired stage.
 *  4. Nobody who could submit it is available.
 *
 * It grants no editing of any kind. The job is signed, so `isFinalized` is
 * already true and every mutation is already refused; a takeover submits the
 * document the technician would have submitted and does nothing else.
 */
export const canTakeOverSubmission = (
  role: UserRole,
  job: Pick<Job, 'status' | 'signature' | 'signatureRefusals'>,
  cover: SubmissionCover,
): boolean => {
  if (!can(role, 'jobs.takeOverSubmission')) return false;
  if (job.signature === null) return false;
  if (job.status !== 'review') return false;
  if (hasOutstandingRefusal(job)) return false;
  return isSubmissionUncovered(cover);
};

/** An outstanding refusal, asked without importing the refusal module. */
const hasOutstandingRefusal = (job: Pick<Job, 'signatureRefusals'>): boolean => {
  const latest = job.signatureRefusals.at(-1);
  return latest !== undefined && latest.resolvedAt === null;
};

/**
 * Whether this person may send the customer their copy AGAIN. CR-07.
 *
 * Deliberately wider than `canSubmitJobCard`, and deliberately not the same
 * question. A re-send is a DELIVERY problem on a job that has already been
 * issued: the document exists, the record is already read-only, and nothing
 * about the job changes. What must not happen is that a bounced email sits
 * unsent because the one technician who submitted it is on leave — so the
 * office, who are the only people who can see the outbox and the failure in
 * the first place, can re-send it too.
 */
export const canResendCustomerCopy = (role: UserRole): boolean =>
  can(role, 'jobs.issueFinal') || can(role, 'jobs.viewAll');

/**
 * Deletion is for an administrative mistake — a duplicate, the wrong customer,
 * a job that should never have existed. Once a technician has accepted it there
 * is real work attached, and the honest action is to CANCEL, which keeps
 * everything.
 */
export const canDeleteJob = (role: UserRole, job: Pick<Job, 'status' | 'acceptedAt'>): boolean => {
  if (role !== 'master') return false;
  if (job.acceptedAt !== null) return false;
  return job.status === 'open' || job.status === 'draft';
};

export const deleteJobRefusal = (
  role: UserRole,
  job: Pick<Job, 'status' | 'acceptedAt'>,
): string | null => {
  if (canDeleteJob(role, job)) return null;
  if (role !== 'master') return 'Only a Master can delete a job.';
  if (job.acceptedAt !== null) {
    return 'A technician has already accepted this job, so it can no longer be deleted. Cancel it instead — that keeps the work and the history.';
  }
  return `A ${jobStatusLabel(job.status).toLowerCase()} job cannot be deleted. Only a job that has not been started can be.`;
};

/**
 * Cancellation is for a legitimate job that will not happen. Allowed while the
 * job is still waiting to be started; once work is under way, cancelling would
 * discard it, so that is deliberately not offered here.
 */
export const canCancelJob = (role: UserRole, status: JobStatus): boolean =>
  role === 'master' && (status === 'open' || status === 'draft');

export const cancelJobRefusal = (role: UserRole, status: JobStatus): string | null => {
  if (canCancelJob(role, status)) return null;
  if (role !== 'master') return 'Only a Master can cancel a job.';
  if (status === 'cancelled') return 'This job is already cancelled.';
  return `A ${jobStatusLabel(status).toLowerCase()} job cannot be cancelled from here, because work has already been recorded against it.`;
};

/**
 * A job that has left the active workflow.
 *
 * Cancellation is the only way out that leaves a record: a deleted job is gone,
 * so there is nothing to ask this about.
 */
export const isJobInactive = (job: Pick<Job, 'status'>): boolean =>
  job.status === 'cancelled';

/**
 * Whether this user may hand this job on.
 *
 * A technician transfers their OWN active job — that is the whole point, since
 * the person who cannot attend is the one who knows. A Master may transfer any
 * active job. Nobody transfers a job that has reached the signature or beyond:
 * the work is done and the customer has signed for it.
 */
export const canTransferJob = (
  actor: { readonly id: string; readonly role: UserRole },
  job: Pick<Job, 'status' | 'primaryTechnicianId'>,
): boolean => {
  if (!TRANSFERABLE_STATUSES.includes(job.status)) return false;
  if (actor.role === 'master') return true;
  return job.primaryTechnicianId === actor.id;
};

const TRANSFERABLE_STATUSES: readonly JobStatus[] = [
  'open',
  'in_progress',
  'awaiting_spares',
  'completion',
];

export const transferJobRefusal = (
  actor: { readonly id: string; readonly role: UserRole },
  job: Pick<Job, 'status' | 'primaryTechnicianId'>,
): string | null => {
  if (canTransferJob(actor, job)) return null;
  if (!TRANSFERABLE_STATUSES.includes(job.status)) {
    return `A ${jobStatusLabel(job.status).toLowerCase()} job cannot be transferred. The customer has already signed for this work.`;
  }
  return 'You can only transfer a job assigned to you.';
};

/**
 * Statuses where labour, travel, parts and media may be captured.
 *
 * Includes Master Review, because a Master correcting a job card routinely needs
 * to add a part that was fitted but not captured, or fix an hours entry.
 */
export const isJobWorkable = (role: UserRole, status: JobStatus): boolean => {
  if (status === 'submitted') return role === 'master';
  return status === 'in_progress' || status === 'awaiting_spares' || status === 'completion';
};

/** The job has been signed, so the customer has committed to what it says. */
export const isAfterSignature = (status: JobStatus): boolean =>
  status === 'review' || status === 'submitted' || status === 'closed';

/**
 * THE JOB IS FINAL. Nobody may change it. MASTER SCOPE CR-01 / IMMUT-1…7.
 *
 * "A customer-signed job card is legally final. Once a customer has signed:
 * NOTHING on the signed job card may be edited" — not by a Master, not by a
 * Coordinator, not by the technician who did the work.
 *
 * WHY THE SIGNATURE AND NOT THE STATUS. A refusal and a signature land in the
 * SAME status: `recordSignatureRefusal` and `captureSignature` both leave the
 * job at `review`. They differ in exactly one thing — a refusal sets
 * `signature: null`, a signature fills it in — and that difference is the whole
 * business rule. A refused job card is explicitly still editable: the office
 * reviews it, corrects it and resubmits it under one of the two outcomes. A
 * signed one is evidence of what a customer agreed to, and evidence that can be
 * edited afterwards is not evidence.
 *
 * So this asks the question the rule actually asks, and no new status was
 * invented to carry an answer the data already had.
 *
 * THE TWO LATER STATES ARE FINAL TOO, and for a different reason: once the job
 * card has been issued the customer is holding a document, so the record has to
 * keep matching it whether or not a signature was ever obtained. That covers
 * the "Without Customer Signature" outcome, which closes with `signature` still
 * null and must be every bit as immutable.
 */
export const isFinalized = (job: Pick<Job, 'signature' | 'status'>): boolean =>
  job.signature !== null || job.status === 'awaiting_delivery' || job.status === 'closed';

/**
 * Whether this role may change this job's RECORD, signature included.
 *
 * `canEditJob` answers only the status half and is kept for the places that ask
 * about a status alone. This is the question every mutation must ask, because
 * status alone cannot tell a signed job from a refused one.
 */
export const canEditJobRecord = (
  role: UserRole,
  job: Pick<Job, 'signature' | 'status'>,
): boolean => {
  if (isFinalized(job)) return false;
  return canEditJob(role, job.status);
};

/** Why the record is closed to changes, in a sentence a person can act on. */
export const finalizedRefusal = (job: Pick<Job, 'signature' | 'status'>): string | null => {
  if (!isFinalized(job)) return null;
  if (job.signature !== null) {
    return (
      'The customer has signed this job card, so it is final and cannot be changed by anyone. ' +
      'If something on it is wrong, raise it with the office — the signed record stays as it is.'
    );
  }
  return 'This job card has been issued to the customer, so the record must keep matching it.';
};

export const isJobOpenWork = (status: JobStatus): boolean =>
  status === 'open' ||
  status === 'in_progress' ||
  status === 'awaiting_spares' ||
  status === 'completion' ||
  status === 'customer_signature' ||
  status === 'review';

export interface RuleViolation {
  readonly code: string;
  readonly message: string;
}

export interface TransitionCheck {
  readonly allowed: boolean;
  readonly violations: readonly RuleViolation[];
}

const ok: TransitionCheck = { allowed: true, violations: [] };

const blocked = (violations: readonly RuleViolation[]): TransitionCheck => ({
  allowed: false,
  violations,
});

/**
 * Requirements that must be satisfied before a job may move from `completion`
 * to `customer_signature`.
 */
export const checkReadyForSignature = (job: Job): TransitionCheck => {
  const definition = getJobTypeDefinition(job.jobType);
  const violations: RuleViolation[] = [];

  /*
   * Collection details, checked HERE and not only where they are chosen.
   *
   * A courier collection needs a waybill, and that rule used to live solely in
   * `setCollectionMethod` — the one screen that offers the choice. Any other
   * caller that reached the signature by another route therefore skipped it and
   * could hand a driver a document with no consignment reference on it at all.
   * Readiness is where the workflow decides what a job still owes, so the rule
   * belongs in it: every path to a signature now passes through this check, and
   * `checkReadyForSubmission` inherits it by calling this function.
   *
   * It is a no-op for every job type that is not collected from the counter,
   * and for a customer collection, which needs no waybill.
   */
  violations.push(...checkCollectionDetails(job).violations);

  // A parts collection records no work and no hours: it is a receipt for goods.
  if (!definition.capturesLabourAndTravel) {
    if (job.parts.length === 0) {
      violations.push({
        code: 'parts_required',
        message: 'At least one part line is required before the collector signs.',
      });
    }
    if (definition.requiresOrderNumber && job.orderNumber.trim().length === 0) {
      violations.push({
        code: 'order_number_required',
        message:
          'An order number is required: it is what ties these goods to the customer’s order.',
      });
    }
    return violations.length === 0 ? ok : blocked(violations);
  }

  if (job.completionReport.workPerformed.trim().length === 0) {
    violations.push({
      code: 'work_performed_required',
      message: 'Work Performed must be completed before the customer signs.',
    });
  }

  if (job.labour.length === 0) {
    violations.push({
      code: 'labour_required',
      message: 'At least one labour entry is required.',
    });
  }

  if (definition.checklistRequired) {
    if (job.checklist === null) {
      violations.push({
        code: 'checklist_missing',
        message: `A ${definition.label.toLowerCase()} checklist is required for this job type.`,
      });
    } else if (job.checklist.completedAt === null) {
      violations.push({
        code: 'checklist_incomplete',
        message: 'The mandatory checklist has not been completed.',
      });
    }
  }

  if (definition.photosRequired && job.photos.length === 0) {
    violations.push({
      code: 'photos_required',
      message: `At least one photo is required for ${definition.label.toLowerCase()} jobs.`,
    });
  }

  return violations.length === 0 ? ok : blocked(violations);
};

/**
 * Requirements before a job may be submitted and closed.
 *
 * The signature stage has two legitimate outcomes, and this is where the
 * difference between them shows:
 *
 * - The customer SIGNED. The technician issues the job card themselves, as
 *   they always have.
 * - The customer REFUSED. The job is not stuck and it is not finished: the
 *   work and the write-up are done, but the office has not yet dealt with why
 *   the customer would not put their name to it. So it waits — at Review, held
 *   by a blocking CONDITION on the job rather than by a stage or a status of
 *   its own — until a Master resolves the signature refusal. Once resolved it
 *   issues exactly as a signed job does: one document, generated once,
 *   emailed, closed on delivery. The technician never repeats the close-out
 *   and never collects a second signature.
 */
export const checkReadyForSubmission = (job: Job): TransitionCheck => {
  const violations: RuleViolation[] = [];
  const latest =
    job.signatureRefusals.length === 0
      ? null
      : (job.signatureRefusals[job.signatureRefusals.length - 1] ?? null);
  const outstanding = latest !== null && latest.resolvedAt === null ? latest : null;

  if (job.signature === null && latest === null) {
    violations.push({
      code: 'signature_required',
      message: 'A customer signature is required before submission.',
    });
  }

  if (job.signature !== null && outstanding !== null) {
    violations.push({
      code: 'conflicting_signature_outcome',
      message:
        'This job records both a customer signature and an outstanding refusal to sign. It cannot be issued until the record says which happened.',
    });
  }

  if (outstanding !== null) {
    violations.push({
      code: 'refusal_unresolved',
      message:
        'The customer refused to sign. The office must correct and resubmit the job card, or issue it without a signature, before it can go out.',
    });
  }

  /*
   * A refusal that was resolved by CORRECTING the job card releases nothing on
   * its own: the corrected card went back to the customer, and either they
   * signed it or they refused again. Only `issued_unsigned` says the office
   * decided to issue the document that records the refusal.
   */
  if (job.signature === null && latest !== null && latest.resolution === 'resubmitted') {
    violations.push({
      code: 'signature_required',
      message:
        'The corrected job card was returned for signature and has not been signed yet.',
    });
  }

  const signatureCheck = checkReadyForSignature(job);
  return violations.length === 0 && signatureCheck.allowed
    ? ok
    : blocked([...violations, ...signatureCheck.violations]);
};

/**
 * Whether this person is on the job: the primary, or attending with them.
 *
 * The domain's answer to "whose job is this", so the read layer, the action bar
 * and the acceptance rule cannot drift apart by each deciding for themselves.
 */
export const isAssignedTo = (
  job: Pick<Job, 'primaryTechnicianId' | 'additionalTechnicianIds'>,
  userId: string,
): boolean =>
  job.primaryTechnicianId === userId ||
  job.additionalTechnicianIds.some((candidate) => candidate === userId);

/**
 * Whether the given user may accept this job. Technician acceptance is what
 * starts the job — there is deliberately no separate Start action.
 *
 * WITHOUT A VIEWER this answers the workflow question only — is the job at a
 * stage where acceptance is the next step — which is the original contract and
 * what a list that is not about one person still asks.
 *
 * WITH A VIEWER it also answers whose job it is, and that is the form a screen
 * should use. An unassigned job is the open pool and anybody doing field work
 * may take it; an assigned job belongs to the people on it. Offering "Accept"
 * to somebody the server will refuse is how a button becomes an error message.
 */
export const canAcceptJob = (
  job: Pick<Job, 'status' | 'jobType' | 'primaryTechnicianId' | 'additionalTechnicianIds'>,
  viewer?: Pick<User, 'id' | 'role'>,
): boolean => {
  if (job.status !== 'open') return false;
  if (viewer === undefined) return true;

  /*
   * A PARTS COLLECTION IS NOT ASSIGNED FIELD WORK.
   *
   * It happens at the EJE counter: whoever is there hands the goods over and
   * takes the collector's signature, which is why `acceptJobRefusal` gates it
   * on `jobs.processParts` rather than on who it is assigned to. A collection
   * may carry a technician's name — the person who prepared it — and the
   * office still processes it.
   *
   * This exception has to be here as well as in the operation, or the screen
   * hides a button the server would have allowed. THE RULE IS UNCHANGED: the
   * office does process parts collections, deliberately, and that is not the
   * same thing as the office accepting field work.
   */
  if (job.jobType === 'parts') return can(viewer.role, 'jobs.processParts');

  /*
   * EVERY OTHER JOB TYPE IS FIELD WORK, AND THE OFFICE DOES NOT ACCEPT IT.
   *
   * `acceptJobRefusal` has always refused a Coordinator here — "Field work is
   * accepted by the technician attending the job" — but this function was not
   * asked WHO was looking, so the Coordinator was shown an Accept job button on
   * every unassigned job and the server then refused it. The person recorded as
   * having attended the machine has to be the person who attended it.
   */
  if (!can(viewer.role, 'jobs.acceptField')) return false;

  return job.primaryTechnicianId === null || isAssignedTo(job, viewer.id);
};
