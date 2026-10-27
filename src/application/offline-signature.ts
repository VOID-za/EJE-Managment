import {
  checkReadyForSignature,
  getJobTypeDefinition,
  isJobTechnician,
  outstandingRefusal,
  type CaptureReferral,
  type Job,
} from '@/domain';
import {
  canComputeDocumentIdentity,
  documentIdentityFor,
  isDocumentIdentity,
} from '@/lib/job-card/document-identity';
import type { OperationContext } from './context';
import { referCapture } from './capture-referral-operations';
import { WorkflowError } from './errors';
import { captureSignature, recordSignatureRefusal, type OfflineCaptureEvidence } from './job-operations';
import { loadJobView } from './job-view';

/**
 * A SIGNATURE OR A REFUSAL TAKEN WITH NO SIGNAL, ARRIVING LATER. BD-23,
 * approved by the owner on 27 October 2026. OFF-5, ACC-OFF-5, ACC-OFF-12.
 *
 * THE APPROVED RULE, as this module holds it:
 *
 *   1. The capture names the exact document the customer was shown, by its
 *      identity (`document-identity.ts`), computed on the tablet from the same
 *      canonical model the PDF is drawn from.
 *   2. On arrival the SERVER recomputes that identity from its own record —
 *      never trusting the tablet's — through the same function and the same
 *      view of the job the technician was given.
 *   3. Identical, and the job still at Customer Signature with nothing else
 *      recorded: the signature or refusal is accepted through the ORDINARY
 *      operation (`captureSignature`, `recordSignatureRefusal`), so every gate,
 *      transition, price freeze, audit line and office notification is exactly
 *      the online one. Nothing here writes a job by itself.
 *   4. Anything else — the document changed, could not be reproduced, the job
 *      moved on, somebody already signed or refused — is NOT accepted and
 *      nothing on the job changes. The capture, with the signature strokes or
 *      the reason, the identity and the tablet's time, is kept as a referral on
 *      the office's Field Captures queue (BD-15's mechanism) with the reason it
 *      was not accepted, and the audit trail says so. No signature is
 *      substituted onto a different document, and a failed check is never
 *      reported as an acceptance.
 *
 * WHY THE REFERRAL IS WRITTEN HERE AND NOT BY THE TABLET. For an ordinary
 * capture the tablet refers a refusal itself, in a second request. A customer's
 * signature is the most consequential record in the system: its evidence is
 * written in the SAME transaction that declines it, so it cannot be lost
 * between two requests on a bad link. The answer is a 200 with
 * `outcome: 'referred'` — the server did decide, and deciding is not an error.
 * A refusal that is about WHO is asking (not on the job, not a technician)
 * still throws, as every command does, and the tablet's BD-15 path refers it.
 *
 * IDEMPOTENT TWICE OVER. A replay under the same key is answered from the first
 * request (`writeRoute`). A replay under another key, of a capture that was in
 * fact accepted, finds the same signature (or the same refusal by the same
 * person) already on the job and answers `accepted` without writing anything —
 * so a lost answer can never become a referral of a signature that landed.
 * Referrals are keyed on the capture's own id, so one capture is one referral.
 *
 * AN OFFICE CANNOT "APPLY" ONE OF THESE FROM THE REFERRAL. That would put a
 * signature on a document the customer did not see. The office resolves it by
 * having the current document signed in the ordinary way and recording, with a
 * reason, that nothing further will happen to the held capture (see the
 * resolve route and `isReferralApplicable`).
 */

export type OfflineSignatureKind = 'signature' | 'refusal';

export const OFFLINE_SIGNATURE_ACTION = 'capture_signature_offline';
export const OFFLINE_REFUSAL_ACTION = 'record_refusal_offline';

interface HeldCaptureBase {
  /** The tablet's own id for the capture, minted once. Keys the referral. */
  readonly captureId: string;
  /** The identity of the document the customer was shown. */
  readonly documentIdentity: string;
  /** SHA-256 of the PDF bytes on screen, as evidence. Never compared. */
  readonly pdfSha256: string | null;
  /** When the tablet took it, by the tablet's clock. */
  readonly capturedAt: string;
}

export interface HeldSignatureInput extends HeldCaptureBase {
  readonly customerName: string;
  readonly customerSurname: string;
  readonly strokeData: string;
}

export interface HeldRefusalInput extends HeldCaptureBase {
  readonly reason: string;
}

/** Why a held capture was not accepted. Stored verbatim on the referral. */
export type OfflineSignatureReferralReason =
  | 'document_changed'
  | 'document_unverifiable'
  | 'job_moved_on'
  | 'already_signed'
  | 'already_refused'
  | 'not_ready';

const REASON_MESSAGE: Readonly<Record<OfflineSignatureReferralReason, string>> = {
  document_changed:
    'The job card on the server is not the document the customer was shown — something on it changed after the tablet displayed it. The customer has not signed the current document.',
  document_unverifiable:
    'The server could not reproduce the document the customer was shown, so it cannot verify what was signed.',
  job_moved_on:
    'The job is no longer waiting for the customer’s signature on the server.',
  already_signed: 'The job card already carries a different customer signature.',
  already_refused: 'A refusal to sign is already recorded and has not been dealt with.',
  not_ready: 'The job is not ready for a customer signature on the server.',
};

export type OfflineSignatureOutcome =
  | { readonly outcome: 'accepted'; readonly job: Job }
  | {
      readonly outcome: 'referred';
      readonly reason: OfflineSignatureReferralReason;
      readonly message: string;
      readonly referral: CaptureReferral;
    };

const isSignature = (
  kind: OfflineSignatureKind,
  input: HeldSignatureInput | HeldRefusalInput,
): input is HeldSignatureInput => kind === 'signature' && 'strokeData' in input;

/** The capture already landed — the same strokes, or the same refusal by the same person. */
const alreadyApplied = (
  context: OperationContext,
  job: Job,
  kind: OfflineSignatureKind,
  input: HeldSignatureInput | HeldRefusalInput,
): boolean => {
  if (isSignature(kind, input)) {
    return (
      job.signature !== null &&
      job.signature.customerName === input.customerName &&
      job.signature.customerSurname === input.customerSurname &&
      job.signature.strokeData === input.strokeData
    );
  }
  const open = outstandingRefusal(job);
  return (
    open !== null &&
    open.recordedBy === context.actor.id &&
    open.reason === (input as HeldRefusalInput).reason.trim()
  );
};

/** The first thing that stops the capture being accepted, or null. */
const obstacle = async (
  context: OperationContext,
  job: Job,
  input: HeldCaptureBase,
): Promise<OfflineSignatureReferralReason | null> => {
  if (job.signature !== null) return 'already_signed';
  if (outstandingRefusal(job) !== null) return 'already_refused';
  if (job.status !== 'customer_signature') return 'job_moved_on';
  if (!checkReadyForSignature(job).allowed) return 'not_ready';

  if (!isDocumentIdentity(input.documentIdentity) || !canComputeDocumentIdentity()) {
    return 'document_unverifiable';
  }
  // The technician's own view: what their tablet was given, prices and all.
  const view = await loadJobView(context.repos, job.jobNumber, context.actor);
  if (view === null) return 'document_unverifiable';
  const serverIdentity = await documentIdentityFor({
    job: view.job,
    customer: view.customer,
    site: view.site,
    contact: view.contact,
    machine: view.machine,
    settings: view.settings,
    checklistTemplate: view.checklistTemplate,
    users: view.users,
  });
  return serverIdentity === input.documentIdentity ? null : 'document_changed';
};

const summaryOf = (kind: OfflineSignatureKind, input: HeldSignatureInput | HeldRefusalInput): string =>
  isSignature(kind, input)
    ? `Customer signature by ${input.customerName} ${input.customerSurname}, taken offline`
    : 'Customer refusal to sign, recorded offline';

export const acceptOfflineSignature = async (
  context: OperationContext,
  job: Job,
  kind: OfflineSignatureKind,
  input: HeldSignatureInput | HeldRefusalInput,
): Promise<OfflineSignatureOutcome> => {
  /*
   * ONLY THE TECHNICIAN WHO HELD IT. A capture held on a tablet is a field
   * act; the office's administrative capture does not extend to presenting a
   * customer's signature it did not witness.
   */
  if (!isJobTechnician(context.actor, job)) {
    throw new WorkflowError(`${job.jobNumber} is not assigned to you.`, [
      {
        code: 'not_on_job',
        message: 'Only a technician on the job can present a signature taken on their tablet.',
      },
    ]);
  }

  /*
   * A JOB TYPE WITH NO REFUSAL WORKFLOW — a parts collection — refuses a held
   * refusal exactly as it refuses an online one, before anything else is
   * asked: it is a rule about the job type, not about the document.
   */
  if (kind === 'refusal' && !getJobTypeDefinition(job.jobType).allowsSignatureRefusal) {
    throw new WorkflowError(`A refusal to sign cannot be recorded on ${job.jobNumber}.`, [
      {
        code: 'not_applicable_to_job_type',
        message: 'This job type has no signature-refusal workflow.',
      },
    ]);
  }

  if (alreadyApplied(context, job, kind, input)) return { outcome: 'accepted', job };

  const reason = await obstacle(context, job, input);
  if (reason === null) {
    const evidence: OfflineCaptureEvidence = {
      documentIdentity: input.documentIdentity,
      capturedAt: input.capturedAt,
      pdfSha256: input.pdfSha256,
    };
    const accepted = isSignature(kind, input)
      ? await captureSignature(
          context,
          job,
          {
            customerName: input.customerName,
            customerSurname: input.customerSurname,
            strokeData: input.strokeData,
          },
          evidence,
        )
      : await recordSignatureRefusal(
          context,
          job,
          { reason: (input as HeldRefusalInput).reason },
          evidence,
        );
    return { outcome: 'accepted', job: accepted };
  }

  const message = REASON_MESSAGE[reason];
  const referral = await referCapture(context, {
    job,
    action: kind === 'signature' ? OFFLINE_SIGNATURE_ACTION : OFFLINE_REFUSAL_ACTION,
    payload: { ...input },
    summary: summaryOf(kind, input),
    capturedAt: input.capturedAt,
    idempotencyKey: `offline-signature:${input.captureId}`,
    refusalCode: reason,
    refusalMessage: `${message} Not accepted; the held capture is kept for the office. Document shown: ${input.documentIdentity}.`,
  });
  return { outcome: 'referred', reason, message, referral };
};
