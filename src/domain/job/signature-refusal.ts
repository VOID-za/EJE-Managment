import type { Job, SignatureRefusal } from '../types/job';
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

/**
 * A reason has to say something.
 *
 * A single character satisfies "not empty" while telling the office nothing,
 * and this record is what a Master reads weeks later to decide whether the
 * customer should be invoiced. Short enough not to obstruct a technician
 * standing in a workshop; long enough to rule out "x", ".", "n/a" and "no".
 */
export const REFUSAL_REASON_MIN_LENGTH = 10;

/** What the job card, the rail and the job screen all call this exception. */
export const SIGNATURE_REFUSED_LABEL = 'Customer refused to sign';

/** Which of the two mutually exclusive outcomes the signature stage produced. */
export type SignatureOutcome = 'none' | 'signed' | 'refused';

export const signatureOutcomeOf = (job: Job): SignatureOutcome => {
  if (job.signature !== null) return 'signed';
  if (job.signatureRefusal !== null) return 'refused';
  return 'none';
};

export const isSignatureRefused = (job: Job): boolean => job.signatureRefusal !== null;

/**
 * A refusal nobody in the office has looked at yet.
 *
 * This is what stops a refusal becoming a notification that sits unread
 * forever: it blocks the job card from being issued, so the exception has to be
 * dealt with rather than merely noticed.
 */
export const refusalAwaitingReview = (job: Job): boolean =>
  job.signatureRefusal !== null && job.signatureRefusal.acknowledgedAt === null;

/** Whether the refusal has been reviewed by a Master. */
export const refusalReviewed = (refusal: SignatureRefusal): boolean =>
  refusal.acknowledgedAt !== null;

/**
 * Validates the reason a technician typed.
 *
 * Returns violations rather than throwing so the wizard can show them beside
 * the field while the operation refuses on exactly the same rule.
 */
export const checkRefusalReason = (reason: string): TransitionCheck => {
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
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
  if (trimmed.length < REFUSAL_REASON_MIN_LENGTH) {
    return {
      allowed: false,
      violations: [
        {
          code: 'refusal_reason_too_short',
          message: `Say why the customer would not sign, in at least ${REFUSAL_REASON_MIN_LENGTH} characters. The office has to be able to act on this.`,
        },
      ],
    };
  }
  return { allowed: true, violations: [] };
};

/**
 * Whether this job may still take the given signature outcome.
 *
 * A job has ONE signature outcome. Signing a job whose customer refused would
 * quietly convert a refusal into an acceptance, and recording a refusal against
 * a signed job would quietly discard a signature the customer gave. Both are
 * refused here, so neither can happen from any caller.
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
              'The customer refused to sign this job card. That refusal stands on the record; it cannot be replaced with a signature.',
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
 * Null for every job without a refusal, which is what keeps this off the rail
 * for normal work. It is a note ON a stage, never a stage of its own.
 */
export const signatureExceptionLabel = (job: Job): string | null =>
  job.signatureRefusal === null ? null : signatoryLabelsFor(job.jobType).refusedLabel;
