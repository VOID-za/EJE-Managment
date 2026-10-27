import { z } from 'zod';
import {
  assertMayResolveReferral,
  loadCaptureReferral,
  resolveCaptureReferral,
} from '@/application/capture-referral-operations';
import { isReferralApplicable } from '@/lib/pwa/offline-rules';
import { JOB_COMMANDS } from '@/server/api/commands/jobs';
import { lookupCommand } from '@/server/api/commands/types';
import { ApiError, notFound } from '@/server/api/errors';
import { writeRoute } from '@/server/api/handler';

const DECISION = z
  .object({
    resolution: z.enum(['applied', 'no_action']),
    note: z.string().max(2000).optional(),
  })
  .strict();

/**
 * THE ONE FIELD THE OFFICE'S DECISION REPLACES. OFF-CHK-1, BD-15.
 *
 * A held checklist answer carries `expectedAnsweredAt`: the answer it was
 * replacing, as the tablet last saw it. Its whole purpose is to stop a DEVICE
 * silently overwriting an answer somebody gave while it was away — and that is
 * exactly the refusal that brings the capture here.
 *
 * So applying it from this screen drops that field, and nothing else. The
 * office is looking at the technician's answer, at the refusal in the server's
 * own words ("somebody answered this item while this tablet was away"), and at
 * the job; their decision is recorded, attributed and audited. That is the
 * opposite of silent, and it is what a resolution IS.
 *
 * WHAT IS NOT DROPPED: `templateId` and `templateVersion`. An answer may never
 * be moved onto a different version of the checklist — the wording the
 * technician answered is the wording the customer's document reports
 * (CHK-VER-1) — and no office decision makes that acceptable. If the job has
 * moved to another version, the apply fails here too and `no_action` with a
 * reason is the honest outcome.
 */
const payloadToApply = (referral: {
  readonly action: string;
  readonly payload: Readonly<Record<string, unknown>>;
}): Readonly<Record<string, unknown>> => {
  if (referral.action !== 'answer_checklist') return referral.payload;
  const { expectedAnsweredAt: _replaced, ...rest } = referral.payload;
  return rest;
};

/**
 * `POST /api/captures/referrals/:referralId/resolve` — the office decides what
 * happens to work a tablet could not get onto a job. BD-15.
 *
 * TWO OUTCOMES, AND NEITHER IS SILENT.
 *
 * `applied` — the capture is put on the job THROUGH THE ORDINARY OPERATION.
 * This route looks the action up in the same closed command registry a browser
 * reaches, validates the stored payload with that action's own schema, and runs
 * it with the office's own authority. So `assertEditable`, `assertCanCapture`,
 * the state machine and the audit trail all apply exactly as they would to a
 * line captured by hand. **There is no path here that writes to a job without
 * passing through the domain, and there must never be one.** If the job still
 * refuses the work — signed, closed, no longer accepting it — the refusal is
 * returned as the server's own words and the referral stays OPEN, because
 * nothing happened and recording that it did would be a lie.
 *
 * `no_action` — nothing further will happen, and the note says why. Required,
 * because "we are not doing anything about your three hours" is only an answer
 * if it has a reason attached.
 *
 * THE CAPTURE'S ORIGINAL KEY IS KEPT, NOT REPLAYED, and the distinction is
 * worth being exact about. An idempotency marker is scoped to
 * `(user, operation, key)`, so the office's apply cannot claim the technician's
 * scope and this route does not pretend to. What stops the hours landing twice
 * is that A REFERRAL IS RESOLVABLE EXACTLY ONCE: the decision and the write to
 * the job commit in the same transaction, and a second attempt is refused with
 * `referral_resolved`. The tablet's key is retained so the capture can be
 * traced to the attempt it was first made under, and so the tablet can
 * reconcile its own pending row against the office's decision. It is also why
 * a referral only ever exists for a capture the server has REFUSED: a capture
 * whose answer was merely lost is retried under its own key and meets the
 * marker, never this route.
 *
 * THE ACTION IS CHECKED AGAINST THE OFFLINE CONTRACT, twice over: the referral
 * route refuses to record an action a tablet was never allowed to hold, and
 * this one refuses to apply one. A referral is not a way to get an arbitrary
 * command in front of the office with an "apply" button next to it.
 */
export const POST = writeRoute({
  operation: 'captures.resolve_referral',
  schema: DECISION,
  handler: async (context) => {
    const referral = await loadCaptureReferral(
      context.operation,
      context.params.referralId ?? '',
    );
    if (referral === null) throw notFound('That referred capture does not exist.');

    /*
     * ASKED BEFORE ANYTHING IS DONE. A technician may READ their own referral,
     * which is how they learn what became of their hours, and must not be able
     * to turn that into applying it; a referral the office has already decided
     * about must not be applied a second time. Both are settled here, before
     * the command below touches the job, rather than left to the transaction —
     * `resolveCaptureReferral` asserts them again as the second line.
     */
    assertMayResolveReferral(context.operation, referral);

    if (context.input.resolution === 'applied') {
      if (!isReferralApplicable(referral.action)) {
        throw new ApiError('validation_failed', 'That capture cannot be applied from here.', [
          {
            code: 'action_not_applicable',
            message: 'Only work a tablet is allowed to hold offline can be applied this way. A signature or refusal held offline is never applied from here — have the current document signed, then record no action with a reason.',
          },
        ]);
      }

      const command = lookupCommand(JOB_COMMANDS, referral.action);
      if (command === null) throw notFound('That capture cannot be applied from here.');

      const parsed = command.schema.safeParse(payloadToApply(referral));
      if (!parsed.success) {
        throw new ApiError('validation_failed', 'That capture is not valid for this job.', [
          {
            code: 'capture_invalid',
            message:
              'The details the tablet held are not acceptable to the job. Record no action instead, with a reason.',
          },
        ]);
      }

      /*
       * The domain decides. A refusal here is NOT turned into a resolution:
       * `resolveCaptureReferral` is never reached, the referral stays open, and
       * the office is told exactly what the job said.
       */
      await command.run(
        {
          repos: context.repos,
          services: context.services,
          actor: context.actor.user,
          operation: context.operation,
        },
        parsed.data,
        referral.jobId,
      );
    }

    const resolved = await resolveCaptureReferral(context.operation, referral, {
      resolution: context.input.resolution,
      note: context.input.note ?? '',
    });

    return { referral: resolved };
  },
});

/*
 * NOTHING HERE CATCHES ANYTHING, deliberately. Every throw above travels
 * through `writeRoute`, which maps a WorkflowError to 422 and a permission
 * refusal to 403 — and, more importantly, rolls the transaction back. A
 * half-applied resolution, where the line landed on the job but the referral
 * stayed open or the other way round, is exactly what must not be possible.
 */
