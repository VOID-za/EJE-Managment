'use client';

import { useCallback, useState } from 'react';
import { isJobTechnician, type Job } from '@/domain';
import { ApiRequestError, newIdempotencyKey } from '@/api/client';
import { jobs as jobsApi } from '@/api/endpoints';
import { canCaptureOffline, type CaptureContext, type OfflineAction } from '@/lib/pwa/offline-rules';
import { isPendingSupported, queueWork } from '@/lib/pwa/pending-work';
import { useApp, useCurrentUser } from '@/providers/AppProvider';
import { useOnline } from '@/hooks/useOnline';

/**
 * CAPTURING WORK WHETHER OR NOT THERE IS SIGNAL. OFF-2, OFF-6, OFF-8.
 *
 * THE SERVER IS TRIED FIRST, ALWAYS. This is not an offline-first cache that
 * writes locally and syncs later; it is an online application that can hold a
 * capture when the network has gone. The difference matters: a capture that
 * reaches the server is on the job immediately, with the server's own
 * validation, pricing and audit trail, and nothing about it is deferred.
 *
 * THE KEY IS MINTED BEFORE THE ATTEMPT, AND KEPT. This is the subtle part. If
 * the request fails with a transport error, the client cannot know whether the
 * server committed it — the answer may have been lost on the way back. So the
 * capture is queued WITH THE SAME IDEMPOTENCY KEY, and the replay is answered
 * from the first request if it did commit. Without that, a yard with bad signal
 * would quietly double a technician's hours.
 *
 * NO NETWORK AT ALL, no attempt: `navigator.onLine` false means the browser
 * knows there is no route, and spending thirty seconds on a doomed request
 * while somebody stands in a plant basement is not worth the certainty.
 *
 * WHAT IT REFUSES. Only the four append-only captures may be held — see
 * `offline-rules.ts`, which this calls rather than re-deciding. Anything else
 * offline is reported as needing a connection, and the reason says which thing
 * it is and why. Nothing is ever accepted and dropped.
 */
export type CaptureOutcome =
  /** The server has it. */
  | { readonly kind: 'sent' }
  /** This tablet is holding it. NOT on the server. */
  | { readonly kind: 'queued' }
  /** Neither: the server refused it, or it cannot be captured offline. */
  | { readonly kind: 'refused'; readonly message: string };

export interface OfflineCaptureResult {
  readonly running: boolean;
  /** The last outcome, for a screen that wants to say what just happened. */
  readonly outcome: CaptureOutcome | null;
  capture(
    action: OfflineAction,
    payload: Readonly<Record<string, unknown>>,
    summary: string,
  ): Promise<CaptureOutcome>;
  clear(): void;
}

export const useOfflineCapture = (job: Job): OfflineCaptureResult => {
  const currentUser = useCurrentUser();
  const { invalidate, reportConnectionError } = useApp();
  const online = useOnline();
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<CaptureOutcome | null>(null);

  const capture = useCallback(
    async (
      action: OfflineAction,
      payload: Readonly<Record<string, unknown>>,
      summary: string,
    ): Promise<CaptureOutcome> => {
      const userId = currentUser?.id ?? '';
      /*
       * What this device believes about the job, from the copy on screen. It
       * narrows what may be queued; it never decides what the server accepts.
       */
      const context: CaptureContext = {
        status: job.status,
        mine: currentUser !== null && isJobTechnician(currentUser, job),
        signed: job.signature !== null,
        observedAt: new Date().toISOString(),
      };

      const hold = async (idempotencyKey: string): Promise<CaptureOutcome> => {
        const verdict = canCaptureOffline(action, context);
        if (!verdict.allowed || userId.length === 0 || !isPendingSupported()) {
          const message =
            verdict.reason ??
            'This tablet cannot hold work for later, so this needs a connection.';
          const refused: CaptureOutcome = { kind: 'refused', message };
          setOutcome(refused);
          return refused;
        }
        try {
          await queueWork({
            userId,
            jobId: job.id,
            jobNumber: job.jobNumber,
            action,
            payload,
            summary,
            idempotencyKey,
            context,
          });
          const queued: CaptureOutcome = { kind: 'queued' };
          setOutcome(queued);
          return queued;
        } catch (cause) {
          const refused: CaptureOutcome = {
            kind: 'refused',
            message:
              cause instanceof Error
                ? cause.message
                : 'This tablet could not hold that capture.',
          };
          setOutcome(refused);
          return refused;
        }
      };

      setRunning(true);
      setOutcome(null);
      try {
        const idempotencyKey = newIdempotencyKey();

        // The browser says there is no route out. Hold it rather than spend a
        // timeout proving the obvious.
        if (!online) return await hold(idempotencyKey);

        try {
          await jobsApi.sendCaptured(job.id, action, payload, idempotencyKey);
          invalidate();
          const sent: CaptureOutcome = { kind: 'sent' };
          setOutcome(sent);
          return sent;
        } catch (cause) {
          const code = cause instanceof ApiRequestError ? cause.code : null;
          if (code === 'network') {
            /*
             * THE SAME KEY. The request may have committed and lost its
             * answer; replaying it under this key is answered from that first
             * request instead of adding the work twice.
             */
            reportConnectionError(
              'No connection to the EJE server. This capture is held on this tablet and is not on the job yet.',
            );
            return await hold(idempotencyKey);
          }
          const refused: CaptureOutcome = {
            kind: 'refused',
            message:
              cause instanceof ApiRequestError
                ? cause.message
                : 'That could not be captured. Please try again.',
          };
          setOutcome(refused);
          return refused;
        }
      } finally {
        setRunning(false);
      }
    },
    [currentUser, invalidate, job, online, reportConnectionError],
  );

  return { running, outcome, capture, clear: () => setOutcome(null) };
};
