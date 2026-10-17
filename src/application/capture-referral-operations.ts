import {
  can,
  isReferralOpen,
  userFullName,
  type CaptureReferral,
  type CaptureReferralState,
  type CaptureResolution,
  type Job,
  type UserId,
} from '@/domain';
import type { OperationContext } from './context';
import { audit } from './audit';
import { WorkflowError } from './errors';

/**
 * WORK A TABLET COULD NOT GET ONTO A JOB, AND WHAT THE OFFICE DOES ABOUT IT.
 * BD-15, answering OFF-QUEUE-DEC-1.
 *
 * THE PROBLEM, PLAINLY. A technician captures three hours in a basement with no
 * signal. By the time the tablet reconnects the job has been signed, closed or
 * transferred, so the server refuses the work — correctly, under exactly the
 * rules it applies online. The hours were worked. The job will not take them.
 * Before this, that capture sat on one tablet with a refusal on it and whether
 * anything ever happened to it depended on somebody remembering to mention it.
 *
 * EJE's decision: RETAIN IT AND REFER IT TO THE OFFICE.
 *
 * THE THREE RULES THIS MODULE EXISTS TO HOLD:
 *
 *   1. REFERRING CHANGES NOTHING ABOUT THE JOB. A referral is a record that a
 *      capture could not be applied. The job is exactly as the server left it.
 *   2. RESOLVING NEVER BYPASSES A DOMAIN RULE. Applying a referred capture runs
 *      the ordinary operation with the ordinary checks — `assertEditable`,
 *      `assertCanCapture`, the state machine — under the office's own
 *      authority. If the job still refuses it, the resolution fails and says
 *      why. There is no back door here, and there must never be one.
 *   3. NOTHING IS SILENT. Every referral and every resolution writes an audit
 *      line against the job, naming who, when, what and why.
 *
 * WHAT IT IS NOT: a job status (a refused capture says nothing about where the
 * job has got to), a queue (nothing retries by itself once referred), and not a
 * new role (the office's existing Master and Coordinator hold the one narrow
 * capability it needs).
 */

/** The narrow office capability. Master and Coordinator; see `access.ts`. */
const assertMayResolve = (context: OperationContext): void => {
  if (can(context.actor.role, 'captures.resolveReferral')) return;
  throw new WorkflowError('Only the office can deal with work referred from a tablet.', [
    {
      code: 'not_permitted',
      message: 'Your role does not resolve captures referred from the field.',
    },
  ]);
};

/**
 * Whether this actor may decide about THIS referral, asked BEFORE anything is
 * done about it.
 *
 * Separate from `resolveCaptureReferral` because of the order the resolve route
 * has to work in: applying a referred capture runs the real command against the
 * job, and that write must not be attempted — never mind committed — by
 * somebody who may not resolve referrals, or against a referral the office has
 * already dealt with. Relying on the transaction to undo it afterwards would
 * make the answer depend on the backend, and the demonstration store has no
 * transaction to roll back.
 *
 * It is asserted AGAIN inside `resolveCaptureReferral`, deliberately: this is
 * the early refusal, not the authority. The authority is the conditional update
 * in the repository, which is what settles two office users deciding at once.
 */
export const assertMayResolveReferral = (
  context: OperationContext,
  referral: CaptureReferral,
): void => {
  assertMayResolve(context);
  if (isReferralOpen(referral)) return;
  throw new WorkflowError('That capture has already been dealt with.', [
    {
      code: 'referral_resolved',
      message: 'Somebody in the office has already decided what happens to it.',
    },
  ]);
};

export interface ReferCaptureInput {
  /** The job the capture was for. Already loaded and visible to this actor. */
  readonly job: Job;
  readonly action: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly summary: string;
  readonly capturedAt: string;
  /** The key the capture was first ATTEMPTED under, from the tablet. */
  readonly idempotencyKey: string;
  readonly refusalCode: string;
  readonly refusalMessage: string;
}

/**
 * Hands a refused capture to the office.
 *
 * IDEMPOTENT ON THE CAPTURE, not on the request: a tablet that refers the same
 * capture twice — a flush that ran twice, a reload mid-request — gets the
 * referral that already exists. One problem, one row on the office's screen.
 *
 * THE TECHNICIAN IS THE ACTOR, always: the referral records who captured the
 * work from the session, never from the request body. A technician can only
 * refer their own capture, and the route has already established that they may
 * see the job.
 */
export const referCapture = async (
  context: OperationContext,
  input: ReferCaptureInput,
): Promise<CaptureReferral> => {
  const existing = await context.repos.captureReferrals.findByCapture(
    context.actor.id,
    input.idempotencyKey,
  );

  const referral: CaptureReferral = {
    id: existing?.id ?? context.services.ids.next('ref'),
    jobId: input.job.id,
    technicianId: context.actor.id,
    action: input.action,
    payload: input.payload,
    summary: input.summary,
    capturedAt: input.capturedAt,
    idempotencyKey: input.idempotencyKey,
    refusalCode: input.refusalCode,
    refusalMessage: input.refusalMessage,
    referredAt: existing?.referredAt ?? context.services.clock.now(),
    state: existing?.state ?? 'open',
    resolvedBy: existing?.resolvedBy ?? null,
    resolvedAt: existing?.resolvedAt ?? null,
    resolution: existing?.resolution ?? null,
    resolutionNote: existing?.resolutionNote ?? '',
  };

  const saved = await context.repos.captureReferrals.save(referral);

  // Audited once, on the first referral. A re-referral is the same problem
  // arriving again and does not deserve a second line on the job's history.
  if (existing === null) {
    await audit(context, {
      jobId: input.job.id,
      type: 'capture_referred',
      summary: `Work captured offline could not be applied: ${input.summary}`,
      detail:
        `${userFullName(context.actor)} captured it on ${input.capturedAt.slice(0, 10)} and the server refused it: ` +
        `${input.refusalMessage} It is retained and referred to the office.`,
    });
  }

  return saved;
};

/**
 * The referrals the office has to deal with, or a technician's own.
 *
 * TWO CALLERS, ONE RULE EACH. The office (`captures.resolveReferral`) sees
 * everything, because dealing with it is their job. A technician sees their
 * OWN, which needs no capability — it is their work, and it is the only way
 * they learn what was decided about it.
 */
export const listCaptureReferrals = async (
  context: OperationContext,
  options: { readonly mine?: boolean; readonly state?: CaptureReferralState } = {},
): Promise<readonly CaptureReferral[]> => {
  if (options.mine === true) {
    return context.repos.captureReferrals.listForTechnician(context.actor.id);
  }
  assertMayResolve(context);
  return context.repos.captureReferrals.list(
    options.state === undefined ? {} : { state: options.state },
  );
};

/** One referral, for the office, or for the technician whose capture it was. */
export const loadCaptureReferral = async (
  context: OperationContext,
  id: string,
): Promise<CaptureReferral | null> => {
  const referral = await context.repos.captureReferrals.findById(id);
  if (referral === null) return null;
  if (can(context.actor.role, 'captures.resolveReferral')) return referral;
  // A technician may read their own and nobody else's — the same 404-shaped
  // answer a job they may not see gives.
  return referral.technicianId === (context.actor.id as UserId) ? referral : null;
};

export interface ResolveReferralInput {
  readonly resolution: CaptureResolution;
  readonly note: string;
}

/**
 * Records the office's decision about a referred capture.
 *
 * WHAT THIS FUNCTION DOES NOT DO: apply the capture. `applied` means the work
 * HAS been put on a job through the ordinary operation — the route does that
 * first, with the action's own validation and the job's own rules, and only
 * calls this once it has succeeded. Keeping the two apart is what stops this
 * becoming a path that writes to a job without passing through the domain.
 *
 * A NOTE IS REQUIRED FOR `no_action`, and that is the whole point of that
 * outcome: "nothing further will happen" is only an answer if it says why.
 *
 * ALREADY RESOLVED IS A REFUSAL, not an overwrite. Two office users reaching
 * for the same referral is settled in the repository's conditional update; the
 * loser is told it has been dealt with and by whom.
 */
export const resolveCaptureReferral = async (
  context: OperationContext,
  referral: CaptureReferral,
  input: ResolveReferralInput,
): Promise<CaptureReferral> => {
  assertMayResolveReferral(context, referral);

  const note = input.note.trim();
  if (input.resolution === 'no_action' && note.length === 0) {
    throw new WorkflowError('Say why nothing further will happen to this capture.', [
      {
        code: 'note_required',
        message:
          'A technician captured this work. Recording that it will not be applied needs a reason.',
      },
    ]);
  }

  const resolved = await context.repos.captureReferrals.resolve({
    ...referral,
    resolvedBy: context.actor.id,
    resolvedAt: context.services.clock.now(),
    resolution: input.resolution,
    resolutionNote: note,
  });

  if (resolved === null) {
    // The conditional update changed nothing: somebody else got there first.
    throw new WorkflowError('That capture has already been dealt with.', [
      {
        code: 'referral_resolved',
        message: 'Somebody in the office decided while this screen was open. Reload to see it.',
      },
    ]);
  }

  await audit(context, {
    jobId: referral.jobId,
    type: 'capture_referral_resolved',
    summary:
      input.resolution === 'applied'
        ? `Referred capture applied to the job: ${referral.summary}`
        : `Referred capture closed with no action: ${referral.summary}`,
    detail:
      `${userFullName(context.actor)} resolved work captured offline on ${referral.capturedAt.slice(0, 10)}. ` +
      (input.resolution === 'applied'
        ? 'It was applied to the job through the ordinary capture.'
        : 'Nothing further will happen to it.') +
      (note.length > 0 ? ` Reason: ${note}` : ''),
  });

  return resolved;
};
