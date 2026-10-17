import { z } from 'zod';
import { OFFLINE_ACTIONS } from '@/lib/pwa/offline-rules';
import { listCaptureReferrals, referCapture } from '@/application/capture-referral-operations';
import { toCaptureReferralRows } from '@/application/capture-referral-view';
import { loadVisibleJob } from '@/server/api/commands/jobs';
import { readRoute, writeRoute } from '@/server/api/handler';

/**
 * `GET /api/captures/referrals` — work a tablet could not get onto a job.
 * BD-15.
 *
 * TWO AUDIENCES, ONE ROUTE, AND THE SERVER DECIDES WHICH. `?mine=1` answers the
 * actor's OWN referrals, which is how a technician learns what the office did
 * with their hours. Without it the route answers every referral, and that needs
 * `captures.resolveReferral` — the office's narrow capability.
 *
 * The scoping is in `listCaptureReferrals`, not here, so there is one place
 * that decides who may read what; this route only passes the question on.
 */
export const GET = readRoute('captures.referrals', async (context) => {
  const url = new URL(context.request.url);
  const mine = url.searchParams.get('mine') === '1';
  const state = url.searchParams.get('state');

  /*
   * A read context carries no `OperationContext`, because a read performs no
   * operation. One is composed here from the unit of work and the SESSION's
   * actor — the actor is never taken from the request, here or anywhere.
   */
  const operation = {
    repos: context.repos,
    services: context.services,
    actor: context.actor.user,
  };

  const referrals = await listCaptureReferrals(operation, {
    mine,
    ...(state === 'open' || state === 'resolved' ? { state } : {}),
  });
  return { rows: await toCaptureReferralRows(operation, referrals) };
});

/**
 * The body a tablet refers a refused capture with.
 *
 * EVERY FIELD IS A CLAIM except the actor, which comes from the session. The
 * action must be one the offline contract allows — a tablet cannot refer a
 * capture for an action it was never allowed to hold, which is what stops this
 * route being a way to get an arbitrary command in front of the office with an
 * "apply" button next to it.
 */
const REFERRAL = z
  .object({
    jobId: z.string().min(1).max(100),
    action: z.enum(OFFLINE_ACTIONS as unknown as [string, ...string[]]),
    payload: z.record(z.string(), z.unknown()),
    summary: z.string().max(500),
    capturedAt: z.string().min(10).max(40),
    idempotencyKey: z.string().min(8).max(200),
    refusalCode: z.string().max(60),
    refusalMessage: z.string().max(2000),
  })
  .strict();

/**
 * `POST /api/captures/referrals` — a tablet hands over a capture the server
 * refused. BD-15.
 *
 * THE ORDER: same-origin → authenticate → validate → is this job visible to
 * this actor at all → record the referral → commit.
 *
 * `loadVisibleJob` is what stops a tablet referring a capture against a job
 * that is none of its technician's business: a job they may not see answers 404,
 * the same as a job that does not exist. Note that it does NOT require the job
 * to still be theirs — that is the entire situation being reported, since the
 * usual reason a capture is refused is that the job moved on.
 *
 * IDEMPOTENT ON THE CAPTURE, in the operation: referring the same capture twice
 * returns the referral that already exists rather than putting two copies of
 * one problem on the office's screen.
 */
export const POST = writeRoute({
  operation: 'captures.refer',
  schema: REFERRAL,
  handler: async (context) => {
    const job = await loadVisibleJob(
      {
        repos: context.repos,
        services: context.services,
        actor: context.actor.user,
        operation: context.operation,
      },
      context.input.jobId,
    );

    const referral = await referCapture(context.operation, {
      job,
      action: context.input.action,
      payload: context.input.payload,
      summary: context.input.summary,
      capturedAt: context.input.capturedAt,
      idempotencyKey: context.input.idempotencyKey,
      refusalCode: context.input.refusalCode,
      refusalMessage: context.input.refusalMessage,
    });

    return { referral };
  },
});
