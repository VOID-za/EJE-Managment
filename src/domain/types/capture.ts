import type { IsoDateTime, JobId, UserId } from './common';

/**
 * A CAPTURE THE TABLET HELD AND THE SERVER REFUSED, HANDED TO THE OFFICE.
 * BD-15 (OFF-QUEUE-DEC-1), answering it.
 *
 * THE SITUATION IT EXISTS FOR, because the shape only makes sense against it. A
 * technician works three hours on a job in a plant basement with no signal. The
 * tablet holds the capture. By the time it reconnects the job has been signed,
 * closed or transferred, so the server refuses the work — correctly, under the
 * same rules it applies online. **The hours are real and the job will not take
 * them.** Before this, the capture sat on that one tablet with a refusal
 * message on it, and whether anybody ever did anything about it depended on the
 * technician remembering to mention it.
 *
 * EJE's answer: retain the capture and refer it to the office. So this is a
 * SERVER-SIDE record of a capture that could not be applied, with the office as
 * its owner.
 *
 * WHAT IT IS NOT, and both matter:
 *
 *   - It is NOT a job status. A refused capture says nothing about where the
 *     job has got to — the job is signed, or closed, or somebody else's — and
 *     inventing a status for it would put an offline exception into the state
 *     machine every screen reads.
 *   - It is NOT an applied line. Nothing about this record changes a job.
 *     Resolving it either applies the capture through the ordinary operation,
 *     with the ordinary rules, or records that nothing further will happen and
 *     why. Until then the job is exactly as the server left it.
 *
 * THE IDEMPOTENCY KEY TRAVELS WITH IT. It is the key the capture was first
 * attempted under, minted on the tablet before the first send — so if the
 * office applies the capture, the write is the same write the technician's
 * tablet was trying to make, and cannot become a second one.
 */
export type CaptureReferralState = 'open' | 'resolved';

/** What the office decided. Deliberately only two, and neither is silent. */
export type CaptureResolution =
  /**
   * The office put the work on a job through the ordinary operation.
   *
   * Not a bypass: it runs `addLabour`, `addNote` and the rest with the office's
   * own authority, through `assertEditable` and `assertCanCapture`. If the job
   * still refuses it, the resolution fails and says why — the office then
   * either fixes the job first or records that nothing further will happen.
   */
  | 'applied'
  /**
   * Nothing further will happen, and the note says why.
   *
   * The honest outcome for hours on a job that has been closed and invoiced:
   * somebody decided, the decision is recorded against the capture, and the
   * technician can see that their work was looked at.
   */
  | 'no_action';

export interface CaptureReferral {
  readonly id: string;
  readonly jobId: JobId;
  /** Who captured it. Taken from their session, never from the request body. */
  readonly technicianId: UserId;
  /** The API action the capture was for — `add_labour`, `add_note`, … */
  readonly action: string;
  /** Exactly the body the action takes, as the tablet held it. */
  readonly payload: Readonly<Record<string, unknown>>;
  /** One line for a list: "2.5 h normal time". */
  readonly summary: string;
  /** When the technician captured it, from the tablet's clock. */
  readonly capturedAt: IsoDateTime;
  /** The key the capture was first attempted under. See above. */
  readonly idempotencyKey: string;
  /** The server's own refusal, kept verbatim: code and message. */
  readonly refusalCode: string;
  readonly refusalMessage: string;
  /** When the tablet referred it, from the server's clock. */
  readonly referredAt: IsoDateTime;
  readonly state: CaptureReferralState;
  readonly resolvedBy: UserId | null;
  readonly resolvedAt: IsoDateTime | null;
  readonly resolution: CaptureResolution | null;
  readonly resolutionNote: string;
}

/** Whether this referral is still the office's to deal with. */
export const isReferralOpen = (referral: Pick<CaptureReferral, 'state'>): boolean =>
  referral.state === 'open';
