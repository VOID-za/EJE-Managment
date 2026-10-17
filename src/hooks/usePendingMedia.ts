'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiRequestError } from '@/api/client';
import { jobs as jobsApi, machines as machinesApi } from '@/api/endpoints';
import { classifyRefusal } from '@/lib/pwa/offline-rules';
import {
  completeMedia,
  discardMedia,
  fileFrom,
  isMediaQueueSupported,
  markMediaAttempt,
  markMediaConflict,
  markMediaUnsent,
  onPendingMediaChanged,
  readPendingMedia,
  requeueMedia,
  type PendingMedia,
} from '@/lib/pwa/pending-media';
import { useApp, useCurrentUser } from '@/providers/AppProvider';
import { useOnline } from '@/hooks/useOnline';

/**
 * SENDING THE PHOTOGRAPHS THIS TABLET IS HOLDING. OFF-MEDIA-1, OFF-7.
 *
 * The same discipline as `usePendingWork`, with one difference that matters:
 * these rows are BYTES, so they are sent one at a time and a transport failure
 * stops the flush rather than hammering a connection that has already proved
 * it cannot carry 2 MB. Everything else is deliberately identical, because a
 * technician should not have to learn two mental models for "the tablet is
 * holding my work":
 *
 *   - capture order, oldest first;
 *   - ONE upload path — the same authenticated multipart routes the online
 *     capture uses, with the same server-side sniffing and authorisation, and
 *     the capture's own idempotency key, so bytes that landed before the
 *     connection died are replayed rather than attached twice;
 *   - nothing is ever discarded here. A refusal keeps the row with the
 *     server's own words on it for a person to decide about (CR-02, OFF-9);
 *   - no session, no send: a 401 leaves every row untouched and stops the
 *     flush, because the server has said nothing about the photographs (BD-16).
 *
 * WHY A REFUSED PHOTOGRAPH IS NOT REFERRED TO THE OFFICE. BD-15's referral
 * carries a capture's JSON payload to a server-side record the office can act
 * on; a photograph is megabytes of bytes that never reached the server, so
 * there is nothing to refer. The row therefore stays on the tablet with the
 * refusal on it — the OFF-QUEUE-7 rule — and the technician either tries again
 * once the job is theirs to photograph or discards it deliberately.
 */
export interface PendingMediaResult {
  readonly rows: readonly PendingMedia[];
  /** Photographs still waiting for the server. */
  readonly waiting: readonly PendingMedia[];
  /** Photographs the server has refused, which need a person. */
  readonly conflicts: readonly PendingMedia[];
  readonly sending: boolean;
  readonly supported: boolean;
  /** True where the server would not consider them, because there is no session. */
  readonly blockedBySession: boolean;
  flush(): Promise<void>;
  retry(id: string): Promise<void>;
  discard(id: string): Promise<void>;
  refresh(): Promise<void>;
}

/** Sends one held photograph through the route its destination names. */
const send = (row: PendingMedia): Promise<unknown> => {
  const file = fileFrom(row);
  const options = { caption: row.caption, idempotencyKey: row.idempotencyKey };

  switch (row.destination.kind) {
    case 'job_photo':
      return jobsApi.uploadMedia(row.jobId, file, {
        ...options,
        visibility: row.destination.visibility,
      });
    case 'checklist_evidence':
      return jobsApi.addChecklistPhoto(row.jobId, row.destination.itemId, file, options);
    case 'machine_photo':
      /*
       * BD-14: the machine photograph carries the job that authorises it, and
       * the server checks that the job is on this machine, is this technician's
       * and is still live — on the REPLAY exactly as it does online. A job that
       * moved on while the tablet was away refuses the photograph, which is the
       * correct answer and why nothing here re-decides it.
       */
      return machinesApi.addPhoto(row.destination.machineId, file, {
        ...options,
        jobId: row.jobId,
      });
  }
};

export const usePendingMedia = (): PendingMediaResult => {
  const currentUser = useCurrentUser();
  const userId = currentUser?.id ?? '';
  const { invalidate } = useApp();
  const online = useOnline();

  const [rows, setRows] = useState<readonly PendingMedia[]>([]);
  const [sending, setSending] = useState(false);
  const [blockedBySession, setBlockedBySession] = useState(false);

  const refresh = useCallback(async () => {
    if (userId.length === 0 || !isMediaQueueSupported()) {
      setRows([]);
      return;
    }
    setRows(await readPendingMedia(userId));
  }, [userId]);

  useEffect(() => {
    let cancelled = false;
    const reread = () => {
      void readPendingMedia(userId).then((found) => {
        if (!cancelled) setRows(found);
      });
    };
    reread();
    // And again whenever the store changes: a photograph held in the media
    // panel has to appear in the queue panel in the same breath.
    const stop = onPendingMediaChanged(reread);
    return () => {
      cancelled = true;
      stop();
    };
  }, [userId]);

  const flush = useCallback(async () => {
    if (userId.length === 0 || !isMediaQueueSupported()) return;
    setSending(true);
    try {
      const held = await readPendingMedia(userId);
      let sentAny = false;
      let sessionBlocked = false;

      for (const row of held) {
        if (row.state !== 'pending') continue;
        /*
         * A row written by a newer build is left alone rather than guessed at.
         * It stays visible to its owner, which is the honest outcome.
         */
        if (row.schemaVersion > 1) continue;

        await markMediaAttempt(userId, row.id);
        try {
          await send(row);
          await completeMedia(userId, row.id);
          sentAny = true;
        } catch (cause) {
          const code = cause instanceof ApiRequestError ? cause.code : null;
          const message =
            cause instanceof ApiRequestError
              ? cause.message
              : 'The photograph could not be attached.';
          const kind = classifyRefusal(code);

          if (kind === 'blocked') {
            sessionBlocked = true;
            break;
          }
          if (kind === 'conflict') {
            await markMediaConflict(userId, row.id, { message, code });
            // Another photograph on another job may still go: unlike a capture
            // queue, a refusal here is about THIS file's destination.
            continue;
          }
          await markMediaUnsent(userId, row.id, { message, code });
          // The network could not carry this file; it will not carry the next.
          break;
        }
      }

      setBlockedBySession(sessionBlocked);
      if (sentAny) invalidate();
      setRows(await readPendingMedia(userId));
    } finally {
      setSending(false);
    }
  }, [userId, invalidate]);

  /*
   * Sent when the signal comes back, and on arrival at a screen that shows the
   * queue. A flush that fails leaves everything held, so acting on
   * `navigator.onLine` — a hint, not proof — costs nothing.
   */
  useEffect(() => {
    if (!online || userId.length === 0) return;
    const timer = setTimeout(() => void flush(), 0);
    return () => clearTimeout(timer);
  }, [online, userId, flush]);

  const retry = useCallback(
    async (id: string) => {
      await requeueMedia(userId, id);
      await flush();
    },
    [userId, flush],
  );

  const discard = useCallback(
    async (id: string) => {
      await discardMedia(userId, id);
      await refresh();
    },
    [userId, refresh],
  );

  return {
    rows,
    waiting: rows.filter((row) => row.state === 'pending'),
    conflicts: rows.filter((row) => row.state === 'conflict'),
    sending,
    supported: isMediaQueueSupported(),
    blockedBySession,
    flush,
    retry,
    discard,
    refresh,
  };
};
