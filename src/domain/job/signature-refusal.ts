import type { Job, RefusalResolution, SignatureRefusal } from '../types/job';
import type { User } from '../types/user';
import { can } from '../access';
import { signatoryLabelsFor } from './signatory';
import type { RuleViolation, TransitionCheck } from './workflow';

/**
 * The rules for a customer who would not sign.
 *
 * Kept in the domain, beside the signature rules rather than inside the screen
 * that offers the choice, because the whole point of a refusal is that it is a
 * fact about the job: the same rules have to hold whether it arrives from the
 * wizard, from a future REST call, or from a test.
 *
 * Refusal is NOT a workflow stage. A job that reaches it has finished the same
 * work, at the same point in the same six-stage lifecycle, and is held at
 * Review by an exception attached to the job — see `signatureExceptionLabel`
 * and `checkReadyForSubmission`. Nothing here adds a status.
 */

/** What the job card, the rail and the job screen all call this exception. */
export const SIGNATURE_REFUSED_LABEL = 'Customer refused to sign';

/** Which of the two mutually exclusive outcomes the signature stage produced. */
export type SignatureOutcome = 'none' | 'signed' | 'refused';

/**
 * The most recent refusal, resolved or not. Null on a job never refused.
 *
 * Refusals are kept oldest-first and never rewritten, so the last one is the
 * one the office is dealing with and the rest are how the job got here.
 */
export const currentRefusal = (job: Pick<Job, 'signatureRefusals'>): SignatureRefusal | null =>
  job.signatureRefusals.length === 0
    ? null
    : (job.signatureRefusals[job.signatureRefusals.length - 1] ?? null);

/**
 * The refusal the office still has to deal with, if any.
 *
 * Only the latest can be outstanding: resolving one is what allows the job to
 * move, and a job cannot collect a second refusal without first having been put
 * back in front of the customer.
 */
export const outstandingRefusal = (
  job: Pick<Job, 'signatureRefusals'>,
): SignatureRefusal | null => {
  const latest = currentRefusal(job);
  return latest !== null && latest.resolvedAt === null ? latest : null;
};

export const signatureOutcomeOf = (job: Job): SignatureOutcome => {
  if (job.signature !== null) return 'signed';
  const latest = currentRefusal(job);
  if (latest === null) return 'none';
  /*
   * Only a refusal RESOLVED BY CORRECTING the job card puts the job back in
   * front of the customer. A refusal the office resolved by issuing the
   * document as it stands is still the outcome of this job's signature stage:
   * the customer said no, EJE issued the card that says so, and a signature
   * captured afterwards would contradict the document already sent.
   */
  return latest.resolution === 'resubmitted' ? 'none' : 'refused';
};

/** Whether this job has ever been refused, resolved or not. */
export const isSignatureRefused = (job: Pick<Job, 'signatureRefusals'>): boolean =>
  job.signatureRefusals.length > 0;

/**
 * A refusal the office has not resolved yet.
 *
 * This is what stops a refusal becoming a notification that sits unread
 * forever: it blocks the job card from being issued, so the exception has to be
 * dealt with rather than merely noticed. It is a blocking CONDITION on the job,
 * not a state the job is in — the job's status is `review`, exactly as it would
 * be had the customer signed.
 */
export const refusalAwaitingResolution = (job: Pick<Job, 'signatureRefusals'>): boolean =>
  outstandingRefusal(job) !== null;

/** Whether this particular refusal has been resolved. */
export const refusalResolved = (refusal: SignatureRefusal): boolean =>
  refusal.resolvedAt !== null;

export const refusalResolutionLabel = (resolution: RefusalResolution): string =>
  resolution === 'resubmitted'
    ? 'Corrected and returned for signature'
    : 'Issued without a signature';

/**
 * Validates the reason a technician typed.
 *
 * PRESENCE, and nothing more. The rule is that a refusal must be explained, not
 * that the system gets to decide whether the explanation is a good one: a
 * technician standing in a workshop writing "Customer unavailable" has said
 * what happened, and a length test cannot tell a terse answer from a useless
 * one. The screen asks for something useful; this only refuses nothing at all.
 *
 * Returns violations rather than throwing so the wizard can show them beside
 * the field while the operation refuses on exactly the same rule.
 */
export const checkRefusalReason = (reason: string): TransitionCheck => {
  if (reason.trim().length === 0) {
    return {
      allowed: false,
      violations: [
        {
          code: 'refusal_reason_required',
          message: 'A reason is required when the customer refuses to sign.',
        },
      ],
    };
  }
  return { allowed: true, violations: [] };
};

/**
 * Whether this job may still take the given signature outcome.
 *
 * A job has ONE signature outcome AT A TIME. Signing a job whose customer has
 * just refused would quietly convert that refusal into an acceptance, and
 * recording a refusal against a signed job would quietly discard a signature
 * the customer gave. Both are refused here, so neither can happen from any
 * caller.
 *
 * A refusal that has been RESOLVED by correcting the job card and returning it
 * for signature is deliberately not a blocker: that is the whole point of
 * resubmitting, and the earlier refusal stays on the record either way.
 */
export const checkSignatureOutcome = (job: Job, intended: 'signed' | 'refused'): TransitionCheck => {
  const current = signatureOutcomeOf(job);
  if (current === 'none' || current === intended) return { allowed: true, violations: [] };

  const violations: readonly RuleViolation[] =
    intended === 'signed'
      ? [
          {
            code: 'already_refused',
            message:
              'The customer refused to sign this job card. Correct it and return it for signature before it can be signed.',
          },
        ]
      : [
          {
            code: 'already_signed',
            message:
              'The customer has already signed this job card, so a refusal cannot be recorded against it.',
          },
        ];
  return { allowed: false, violations };
};

/**
 * The one-line exception shown beside the Customer Signature stage.
 *
 * Null once the refusal has been resolved, because the job is no longer held by
 * it — the history stays on the record and is read from the refusal panel.
 * Null for every job never refused, which is what keeps this off the rail for
 * normal work. It is a note ON a stage, never a stage of its own.
 */
export const signatureExceptionLabel = (job: Job): string | null =>
  outstandingRefusal(job) === null ? null : signatoryLabelsFor(job.jobType).refusedLabel;

/**
 * Who may see that a customer refused to sign, and why.
 *
 * A refusal reason is a note about a customer's conduct on somebody else's job.
 * The office owns it; the technician who was turned away has to be able to see
 * what was recorded against their own work; and no other technician has any
 * business reading either.
 *
 * "Their own work" is the job they were sent to, or a refusal they themselves
 * took — an additional technician who stood at the counter and was refused can
 * still see the record of it.
 */
export const canSeeSignatureRefusal = (
  user: Pick<User, 'id' | 'role'>,
  job: Pick<Job, 'primaryTechnicianId' | 'signatureRefusals'>,
): boolean => {
  if (can(user.role, 'jobs.viewAnySignatureRefusal')) return true;
  if (job.primaryTechnicianId === user.id) return true;
  return job.signatureRefusals.some((refusal) => refusal.recordedBy === user.id);
};

/**
 * The job as this viewer is allowed to read it.
 *
 * Redaction, not hiding: a technician who may not see another technician's
 * refusal is handed a job with no refusals on it at all, so no screen, no list
 * and no hand-typed URL can render what is not there. Applied where the job is
 * loaded FOR A PERSON; the operations themselves work on the whole record,
 * because the rules have to be enforced against the truth.
 */
export const redactRefusalsForViewer = <
  T extends Pick<Job, 'primaryTechnicianId' | 'signatureRefusals'>,
>(
  job: T,
  viewer: Pick<User, 'id' | 'role'> | null,
): T => {
  if (viewer === null) return job;
  if (canSeeSignatureRefusal(viewer, job)) return job;
  return { ...job, signatureRefusals: [] };
};
