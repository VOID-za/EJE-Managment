import { isDocumentIdentity } from '@/lib/job-card/document-identity';
import type { CaptureContext } from './offline-rules';
import { queueWork, type PendingWork } from './pending-work';

/**
 * HOLDING A CUSTOMER'S SIGNATURE OR REFUSAL ON THE TABLET. BD-23, approved by
 * the owner on 27 October 2026.
 *
 * The tablet side of `offline-signature.ts`. It decides only whether a held
 * capture would be HONEST — that the customer was shown a complete, current
 * document whose identity is known. Whether it is ACCEPTED is the server's
 * decision on arrival, against its own record.
 *
 * Refused here, each with the reason the technician is shown:
 *
 *   - no identity: this browser cannot compute one (not a secure context), or
 *     the document has not been drawn on this screen;
 *   - a stale identity: the document on screen was drawn from an older copy
 *     of the job than the one the signature would be recorded against;
 *   - missing photographs: a genuine customer-facing photograph could not be
 *     drawn, so the customer was not shown the complete document;
 *   - unsent work for this job held on this tablet: it is not on the server's
 *     job card yet, so the document shown is not the one that will be issued
 *     (the server would refer the signature anyway — this says so first).
 *
 * Once held, the row is ordinary pending work: durable in IndexedDB through a
 * restart, a lock or a flat battery, sent oldest first under its own
 * idempotency key, never deleted except by the server's answer.
 */

export interface PresentedDocument {
  readonly identity: string | null;
  readonly pdfSha256: string | null;
  readonly photosMissing: number;
}

export interface HoldCheck {
  readonly allowed: boolean;
  readonly reason: string | null;
}

export const checkSignatureHoldable = (input: {
  /** What the screen drew and reported. Null if nothing was drawn. */
  readonly presented: PresentedDocument | null;
  /** The identity of the job as the screen holds it now. */
  readonly currentIdentity: string | null;
  /** Unsent captures and photographs this tablet holds for the job. */
  readonly heldForJob: number;
}): HoldCheck => {
  const { presented, currentIdentity, heldForJob } = input;
  if (presented === null || presented.identity === null || currentIdentity === null) {
    return {
      allowed: false,
      reason:
        'With no signal, a signature can only be held once the job card has been shown on this screen and this tablet can fingerprint it. Show the customer the job card above, or wait for a signal.',
    };
  }
  if (!isDocumentIdentity(presented.identity) || presented.identity !== currentIdentity) {
    return {
      allowed: false,
      reason:
        'The job card on screen is not the latest copy of this job. Let it redraw and show the customer again before they sign.',
    };
  }
  if (presented.photosMissing > 0) {
    return {
      allowed: false,
      reason: `${presented.photosMissing} photograph${presented.photosMissing === 1 ? '' : 's'} on the job card could not be shown without a signal, so the customer has not seen the complete document. Wait for a signal to take the signature.`,
    };
  }
  if (heldForJob > 0) {
    return {
      allowed: false,
      reason:
        'This tablet is still holding work for this job that the server has not received, so the job card the customer would sign is not the one EJE will issue. Send it when there is a signal, then take the signature.',
    };
  }
  return { allowed: true, reason: null };
};

/**
 * The server's answer to a held signature or refusal, read off the response.
 *
 * Both outcomes are a 200: `accepted` (the job now carries it) and
 * `referred` (nothing on the job changed; the office has the evidence). Any
 * other shape — an ordinary job, from an older server — is not mistaken for a
 * referral.
 */
export const referredOutcome = (
  answer: unknown,
): { readonly referralId: string; readonly message: string; readonly reason: string } | null => {
  if (answer === null || typeof answer !== 'object') return null;
  const record = answer as {
    outcome?: unknown;
    message?: unknown;
    reason?: unknown;
    referral?: { id?: unknown };
  };
  if (record.outcome !== 'referred' || typeof record.referral?.id !== 'string') return null;
  return {
    referralId: record.referral.id,
    message: typeof record.message === 'string' ? record.message : 'Not accepted; referred to the office.',
    reason: typeof record.reason === 'string' ? record.reason : 'referred',
  };
};

export type HeldSignatureContent =
  | {
      readonly kind: 'signature';
      readonly customerName: string;
      readonly customerSurname: string;
      readonly strokeData: string;
    }
  | { readonly kind: 'refusal'; readonly reason: string };

/** Holds the capture as pending work. The caller has checked it is holdable. */
export const holdSignature = async (input: {
  readonly userId: string;
  readonly jobId: string;
  readonly jobNumber: string;
  readonly content: HeldSignatureContent;
  readonly presented: PresentedDocument & { readonly identity: string };
  readonly context: CaptureContext;
  readonly idempotencyKey: string;
}): Promise<PendingWork> => {
  const capturedAt = new Date().toISOString();
  const base = {
    captureId: globalThis.crypto.randomUUID(),
    documentIdentity: input.presented.identity,
    pdfSha256: input.presented.pdfSha256,
    capturedAt,
  };
  const { content } = input;
  return queueWork({
    userId: input.userId,
    jobId: input.jobId,
    jobNumber: input.jobNumber,
    action: content.kind === 'signature' ? 'capture_signature_offline' : 'record_refusal_offline',
    payload:
      content.kind === 'signature'
        ? {
            ...base,
            customerName: content.customerName,
            customerSurname: content.customerSurname,
            strokeData: content.strokeData,
          }
        : { ...base, reason: content.reason },
    summary:
      content.kind === 'signature'
        ? `Customer signature — ${content.customerName} ${content.customerSurname} (held; checked against the job card when it arrives)`
        : 'Customer refused to sign (held; checked against the job card when it arrives)',
    idempotencyKey: input.idempotencyKey,
    context: input.context,
  });
};
