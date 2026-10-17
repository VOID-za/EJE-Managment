'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiRequestError } from '@/api/client';
import { jobs as jobsApi } from '@/api/endpoints';
import { classifyRefusal } from '@/lib/pwa/offline-rules';
import {
  PENDING_SCHEMA_VERSION,
  completeWork,
  discardWork,
  isPendingSupported,
  markAttempt,
  markConflict,
  markUnsent,
  onPendingWorkChanged,
  readPendingWork,
  requeueWork,
  type PendingWork,
} from '@/lib/pwa/pending-work';
import { useApp, useCurrentUser } from '@/providers/AppProvider';
import { useOnline } from '@/hooks/useOnline';

/**
 * SENDING WHAT THE TABLET HAS BEEN HOLDING. OFF-6, OFF-7, OFF-8, OFF-9.
 *
 * THE ORDER IS THE CAPTURE ORDER, one request at a time. Not for politeness:
 * a technician captures 2.5 hours and then a part, and a server that received
 * them in the other order would be fine — but a technician reading the
 * activity trail afterwards would not, and ACC-OFF-7 says queued work is sent
 * in the order it was captured.
 *
 * A CONFLICT STOPS THAT JOB'S QUEUE AND NOTHING ELSE. If the server refuses a
 * capture because the job was signed, closed, cancelled or reassigned, every
 * later capture on THAT job would be refused for the same reason — so sending
 * them would be three identical refusals and three rows to resolve instead of
 * one. Other jobs keep going, because their state is unrelated.
 *
 * NOTHING IS EVER DISCARDED HERE. A refusal leaves the row with the server's
 * own words on it for a person to decide about (CR-02, OFF-9); a transport
 * failure leaves it exactly as it was. The only automatic removal is the
 * server accepting it.
 *
 * NOT A BACKGROUND SYNC. This runs in the page, while a technician is looking
 * at it: on reconnection, on load, and when they tap *Send now*. A service
 * worker replaying writes with no screen to report to is Phase 4's own
 * decision to make, and it needs an answer to OFF-9 first.
 */
export interface PendingWorkResult {
  readonly rows: readonly PendingWork[];
  /** Captures still waiting for the server. */
  readonly waiting: readonly PendingWork[];
  /** Captures the server has refused, which need a person. */
  readonly conflicts: readonly PendingWork[];
  readonly flushing: boolean;
  readonly supported: boolean;
  /** Sends everything waiting, oldest first. */
  flush(): Promise<void>;
  /** Puts one refused capture back in the queue, unchanged, and sends. */
  retry(id: string): Promise<void>;
  /** Abandons one capture. The only way work is ever destroyed. */
  discard(id: string): Promise<void>;
  /** Re-reads the store, for a screen that has just queued something. */
  refresh(): Promise<void>;
}

export const usePendingWork = (): PendingWorkResult => {
  const currentUser = useCurrentUser();
  const userId = currentUser?.id ?? '';
  const { invalidate } = useApp();
  const online = useOnline();

  const [rows, setRows] = useState<readonly PendingWork[]>([]);
  const [flushing, setFlushing] = useState(false);

  const refresh = useCallback(async () => {
    if (userId.length === 0 || !isPendingSupported()) {
      setRows([]);
      return;
    }
    setRows(await readPendingWork(userId));
  }, [userId]);

  useEffect(() => {
    let cancelled = false;
    const reread = () => {
      void readPendingWork(userId).then((found) => {
        if (!cancelled) setRows(found);
      });
    };
    reread();
    /*
     * And again whenever the store changes. A capture queued in the work panel
     * has to appear in this panel in the same breath — a queue that only shows
     * up after the next navigation reads like work that was dropped.
     */
    const stop = onPendingWorkChanged(reread);
    return () => {
      cancelled = true;
      stop();
    };
  }, [userId]);

  const flush = useCallback(async () => {
    if (userId.length === 0 || !isPendingSupported()) return;
    setFlushing(true);
    try {
      const queued = (await readPendingWork(userId)).filter((row) => row.state === 'pending');
      /** Jobs whose queue has stopped on a refusal during THIS flush. */
      const blocked = new Set<string>();
      let sentAny = false;

      for (const row of queued) {
        if (blocked.has(row.jobId)) continue;
        /*
         * A row written by a newer build is left alone rather than guessed at.
         * It stays visible to its owner, which is the honest outcome: this
         * build cannot promise to send something it does not understand.
         */
        if (row.schemaVersion > PENDING_SCHEMA_VERSION) continue;

        await markAttempt(row.id);
        try {
          await jobsApi.sendCaptured(row.jobId, row.action, row.payload, row.idempotencyKey);
          await completeWork(row.id);
          sentAny = true;
        } catch (cause) {
          const code = cause instanceof ApiRequestError ? cause.code : null;
          const message =
            cause instanceof ApiRequestError
              ? cause.message
              : 'The EJE server could not be reached.';

          if (classifyRefusal(code) === 'conflict') {
            await markConflict(row.id, { message, code });
            // Everything else queued against this job would be refused for the
            // same reason; one row to resolve is better than five.
            blocked.add(row.jobId);
          } else {
            await markUnsent(row.id, { message, code });
            // The network is the problem, so nothing further will get through
            // this flush either.
            break;
          }
        }
      }

      // Anything that landed changed the job on the server, so every screen
      // reading it is stale — the same signal an ordinary write sends.
      if (sentAny) invalidate();
      setRows(await readPendingWork(userId));
    } finally {
      setFlushing(false);
    }
  }, [userId, invalidate]);

  /*
   * SENT WHEN THE SIGNAL COMES BACK, and on arrival at a screen that shows the
   * queue. `online` is a hint and not proof — a flush that fails leaves
   * everything queued, so acting on the hint costs nothing and waiting for
   * certainty would mean never trying.
   */
  useEffect(() => {
    if (!online || userId.length === 0) return;
    /*
     * Scheduled rather than called in the effect body: a flush sets state as
     * its first act, and doing that while React is still committing this
     * render is a cascading render. A tick's delay also means a reconnection
     * that flickers does not start two flushes.
     */
    const timer = setTimeout(() => void flush(), 0);
    return () => clearTimeout(timer);
  }, [online, userId, flush]);

  const retry = useCallback(
    async (id: string) => {
      await requeueWork(id);
      await flush();
    },
    [flush],
  );

  const discard = useCallback(
    async (id: string) => {
      await discardWork(id);
      await refresh();
    },
    [refresh],
  );

  return {
    rows,
    waiting: rows.filter((row) => row.state === 'pending'),
    conflicts: rows.filter((row) => row.state === 'conflict'),
    flushing,
    supported: isPendingSupported(),
    flush,
    retry,
    discard,
    refresh,
  };
};
