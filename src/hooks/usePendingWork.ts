'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiRequestError } from '@/api/client';
import { captures as capturesApi, jobs as jobsApi } from '@/api/endpoints';
import { classifyRefusal } from '@/lib/pwa/offline-rules';
import { referredOutcome } from '@/lib/pwa/held-signature';
import {
  PENDING_SCHEMA_VERSION,
  clearSending,
  completeWork,
  discardWork,
  isPendingSupported,
  markAttempt,
  markConflict,
  markReferred,
  markUnsent,
  onPendingWorkChanged,
  markSending,
  readPendingWork,
  requeueWork,
  sendingIds,
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
  /** Captures the office now has, and is deciding about. BD-15. */
  readonly referred: readonly PendingWork[];
  readonly flushing: boolean;
  /**
   * The captures whose request is open right now. OFF-8.
   *
   * So a row can say "Sending…" for itself, rather than one spinner standing
   * for twelve captures on a bad link.
   */
  readonly sending: readonly string[];
  readonly supported: boolean;
  /**
   * True where the server would not even consider the work, because there is
   * no session. BD-16: the remedy is signing in again, not an office decision,
   * so the queue says so instead of marking the work refused.
   */
  readonly blockedBySession: boolean;
  /** Referrals the office resolved since this screen opened. BD-15. */
  readonly resolvedCount: number;
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
  const [sending, setSending] = useState<readonly string[]>([]);
  const [blockedBySession, setBlockedBySession] = useState(false);
  const [resolvedCount, setResolvedCount] = useState(0);

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
      if (!cancelled) setSending(sendingIds());
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

  /**
   * Hands one refused capture to the office. BD-15.
   *
   * Called the moment a capture is refused, because at that moment the tablet
   * demonstrably HAS a connection — the refusal came from the server. If the
   * referral itself cannot be sent the row stays `conflict` and the next flush
   * tries again, which is why this reports success rather than throwing.
   */
  const refer = useCallback(
    async (row: PendingWork, refusal: { message: string; code: string | null }) => {
      try {
        const referred = await capturesApi.refer({
          jobId: row.jobId,
          action: row.action,
          payload: row.payload,
          summary: row.summary,
          capturedAt: row.capturedAt,
          idempotencyKey: row.idempotencyKey,
          refusalCode: refusal.code ?? '',
          refusalMessage: refusal.message,
        });
        await markReferred(userId, row.id, referred.referral.id);
        return true;
      } catch {
        // The office has not got it, so the row keeps saying so.
        return false;
      }
    },
    [userId],
  );

  /**
   * Clears local rows the office has finished with. BD-15.
   *
   * The referral is the record now, server-side. Once it is resolved the local
   * row has nothing left to say, so it goes — and the count is kept so the
   * screen can tell the technician their work was dealt with rather than
   * having a row vanish silently.
   */
  const reconcileReferred = useCallback(
    async (held: readonly PendingWork[]) => {
      const referred = held.filter((row) => row.state === 'referred');
      if (referred.length === 0) return 0;

      const mine = await capturesApi.referrals({ mine: true }).catch(() => null);
      if (mine === null) return 0;

      const resolved = new Set(
        mine.rows
          .filter((entry) => entry.referral.state === 'resolved')
          .map((entry) => entry.referral.id),
      );
      let cleared = 0;
      for (const row of referred) {
        if (row.referralId !== undefined && resolved.has(row.referralId)) {
          await completeWork(userId, row.id);
          cleared += 1;
        }
      }
      return cleared;
    },
    [userId],
  );

  const flush = useCallback(async () => {
    if (userId.length === 0 || !isPendingSupported()) return;
    setFlushing(true);
    try {
      const held = await readPendingWork(userId);
      const queued = held.filter((row) => row.state === 'pending');
      /** Jobs whose queue has stopped on a refusal during THIS flush. */
      const blocked = new Set<string>();
      let sentAny = false;
      let sessionBlocked = false;

      for (const row of queued) {
        if (blocked.has(row.jobId)) continue;
        /*
         * A row written by a newer build is left alone rather than guessed at.
         * It stays visible to its owner, which is the honest outcome: this
         * build cannot promise to send something it does not understand.
         */
        if (row.schemaVersion > PENDING_SCHEMA_VERSION) continue;

        await markAttempt(userId, row.id);
        // This row, now: the panel and the checklist both show it on the row
        // rather than as one spinner for the whole queue.
        markSending(row.id);
        try {
          const answer: unknown = await jobsApi.sendCaptured(
            row.jobId,
            row.action,
            row.payload,
            row.idempotencyKey,
          );
          /*
           * A HELD SIGNATURE OR REFUSAL THE SERVER DID NOT ACCEPT. BD-23.
           * The server decided — the job card had changed, or could not be
           * verified — and kept the evidence for the office in the same
           * transaction. So the row is marked referred with the server's own
           * reason, exactly as a refused capture is once BD-15 refers it, and
           * nothing is reported as signed.
           */
          const referred = referredOutcome(answer);
          if (referred !== null) {
            await markConflict(userId, row.id, { message: referred.message, code: referred.reason });
            await markReferred(userId, row.id, referred.referralId);
            blocked.add(row.jobId);
          } else {
            await completeWork(userId, row.id);
          }
          sentAny = true;
        } catch (cause) {
          const code = cause instanceof ApiRequestError ? cause.code : null;
          const message =
            cause instanceof ApiRequestError
              ? cause.message
              : 'The EJE server could not be reached.';
          const kind = classifyRefusal(code);

          if (kind === 'blocked') {
            /*
             * NO SESSION, SO THE SERVER SAID NOTHING ABOUT THE WORK. BD-16.
             * The capture is untouched — not refused, not referred, not
             * attempted again — and the flush stops: everything after this
             * would get the same 401. Signing in again is the remedy.
             */
            sessionBlocked = true;
            break;
          }

          if (kind === 'conflict') {
            await markConflict(userId, row.id, { message, code });
            // BD-15: the server has decided, so the capture is retained and
            // handed to the office rather than left on one tablet.
            await refer(row, { message, code });
            // Everything else queued against this job would be refused for the
            // same reason; one problem referred is better than five.
            blocked.add(row.jobId);
          } else {
            await markUnsent(userId, row.id, { message, code });
            // The network is the problem, so nothing further will get through
            // this flush either.
            break;
          }
        } finally {
          // Whatever happened — sent, refused, referred or a dead link — this
          // row's request is closed, so it must stop saying it is sending.
          clearSending(row.id);
        }
      }

      setBlockedBySession(sessionBlocked);

      /*
       * Captures referred EARLIER that could not be handed over at the time,
       * and referrals the office has since resolved. Both are skipped entirely
       * when there is no session: nothing is asked of a server that has just
       * refused to talk to us.
       */
      if (!sessionBlocked) {
        for (const row of held.filter((entry) => entry.state === 'conflict')) {
          await refer(row, {
            message: row.lastError ?? 'The server refused this capture.',
            code: row.lastErrorCode,
          });
        }
        const cleared = await reconcileReferred(await readPendingWork(userId));
        if (cleared > 0) setResolvedCount((count) => count + cleared);
      }

      // Anything that landed changed the job on the server, so every screen
      // reading it is stale — the same signal an ordinary write sends.
      if (sentAny) invalidate();
      setRows(await readPendingWork(userId));
    } finally {
      setFlushing(false);
    }
  }, [userId, invalidate, refer, reconcileReferred]);

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
      await requeueWork(userId, id);
      await flush();
    },
    [userId, flush],
  );

  const discard = useCallback(
    async (id: string) => {
      // A held signature refuses to be discarded (BD-23); the row stays, as it should.
      await discardWork(userId, id).catch(() => undefined);
      await refresh();
    },
    [userId, refresh],
  );

  return {
    rows,
    waiting: rows.filter((row) => row.state === 'pending'),
    conflicts: rows.filter((row) => row.state === 'conflict'),
    referred: rows.filter((row) => row.state === 'referred'),
    flushing,
    sending,
    supported: isPendingSupported(),
    blockedBySession,
    resolvedCount,
    flush,
    retry,
    discard,
    refresh,
  };
};
