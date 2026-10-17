'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError, newIdempotencyKey } from '@/api/client';
import { useApp } from '@/providers/AppProvider';
import { useOnline } from '@/hooks/useOnline';

/**
 * ONE PHOTOGRAPH, SENT ONCE, RETRIED SAFELY. TAB-UPLOAD-1.
 *
 * THE FAILURE THIS EXISTS FOR. A tablet on a plant's edge-of-coverage WiFi
 * sends 2 MB of photograph, the server stores it and commits, and the answer
 * never arrives. The technician sees a failure and taps again. Without a key,
 * that is two photographs on a job card somebody is about to sign — and the
 * second one is indistinguishable from a deliberate second shot, so nobody can
 * clean it up afterwards with any confidence.
 *
 * So the key is minted ONCE per capture, held here, and reused for every
 * attempt at that capture. The server replays the first answer instead of
 * storing the bytes twice (`uploadRoute`). A genuinely new photograph is a new
 * capture and mints its own key.
 *
 * WHAT IT REPORTS, and the distinction is the point of OFF-8: `uploading` is
 * in flight, `failed` is NOT on the server and the technician must decide, and
 * a cleared state means the server confirmed it. Nothing here ever says
 * "saved" on its own authority.
 */
export type PhotoUploadState =
  | 'idle'
  | 'uploading'
  /** NOT on the server, and nobody is holding it. The technician decides. */
  | 'failed'
  /**
   * NOT on the server, and this tablet is keeping the bytes. OFF-MEDIA-1.
   *
   * Distinct from `failed` because the two mean opposite things to the person
   * standing at the machine: one says "take it again", the other says "carry
   * on, it goes when you have signal". Only a caller that supplied a `hold`
   * can reach it.
   */
  | 'held';

export interface PhotoUploadResult<TContext = void> {
  readonly state: PhotoUploadState;
  /** The server's own words, where it gave any. */
  readonly error: string | null;
  /** The capture waiting to be retried, so the screen can name it. */
  readonly fileName: string | null;
  readonly attempts: number;
  /**
   * Starts a NEW capture: a new key, a new attempt count.
   *
   * `context` is whatever the caller needs to send WITH the file — the
   * checklist item id, for instance. It is captured here and reused verbatim
   * on a retry, which is why a retry cannot drift onto a different item: the
   * alternative, reading it out of component state when the retry happens,
   * is the stale-closure bug this signature exists to prevent.
   */
  send(file: File, context: TContext): Promise<boolean>;
  /** Re-sends the SAME capture under the SAME key. */
  retry(): Promise<boolean>;
  /** Gives up on it, locally. Nothing is removed from the server. */
  dismiss(): void;
}

export const usePhotoUpload = <TContext = void,>(
  upload: (file: File, idempotencyKey: string, context: TContext) => Promise<unknown>,
  /**
   * Keeps the bytes on the device when they could not be sent. OFF-MEDIA-1.
   *
   * Optional, and each caller supplies its own because only the caller knows
   * where the photograph is going — a job's media, a checklist item's evidence,
   * or a machine's record. It is given the SAME key the attempt used, so the
   * queue's eventual send is a retry of this capture and not a second one.
   *
   * Without it, a failed upload behaves exactly as it always did: the file is
   * kept in this hook's state for a manual retry and lost if the tablet is
   * closed. That is still the right behaviour for anything that is not a
   * technician's photograph of work in front of them.
   */
  hold?: (file: File, idempotencyKey: string, context: TContext) => Promise<boolean>,
): PhotoUploadResult<TContext> => {
  const { invalidate, reportConnectionError } = useApp();
  const online = useOnline();
  const [state, setState] = useState<PhotoUploadState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);
  /*
   * The capture waiting on an answer, in STATE rather than a ref, because the
   * screen renders its name in the failure notice. The key inside it is the
   * whole point: it is minted once and survives every retry of this capture.
   */
  const [capture, setCapture] = useState<{
    readonly file: File;
    readonly key: string;
    readonly context: TContext;
  } | null>(null);

  // The uploader closure is a fresh one on every render. Kept in a ref that is
  // only ever written in an effect, so a retry uses the current closure without
  // this hook's identity churning on every parent render.
  const uploader = useRef(upload);
  useEffect(() => {
    uploader.current = upload;
  });

  const holder = useRef(hold);
  useEffect(() => {
    holder.current = hold;
  });

  /** Hands the bytes to the device's queue, if this caller has one. */
  const keep = useCallback(
    async (file: File, key: string, context: TContext, message: string): Promise<boolean> => {
      const keeper = holder.current;
      if (keeper === undefined) return false;
      const kept = await keeper(file, key, context).catch(() => false);
      if (!kept) return false;
      /*
       * The queue owns the capture now, so this hook lets go of it: leaving it
       * here as well would give the technician two ways to send one
       * photograph, and a *Try again* that raced the flush.
       */
      setCapture(null);
      setError(message);
      setState('held');
      setAttempts(0);
      return true;
    },
    [],
  );

  const run = useCallback(
    async (file: File, key: string, context: TContext): Promise<boolean> => {
      setState('uploading');
      setError(null);
      setAttempts((count) => count + 1);

      /*
       * NO NETWORK AT ALL, NO ATTEMPT — where there is somewhere to keep it.
       * Spending thirty seconds pushing two megabytes at a tablet's dead
       * connection, while somebody stands in a plant basement, buys nothing
       * that the queue does not already give.
       */
      if (!online && holder.current !== undefined) {
        const kept = await keep(
          file,
          key,
          context,
          'No connection to the EJE server. The photograph is kept on this tablet and is not on the job yet.',
        );
        if (kept) return false;
      }

      try {
        await uploader.current(file, key, context);
        setCapture(null);
        setState('idle');
        setAttempts(0);
        // Something changed on the server, so every screen reading this job is
        // stale. The same signal every other write sends.
        invalidate();
        return true;
      } catch (cause) {
        const message =
          cause instanceof ApiRequestError
            ? cause.message
            : 'The photograph could not be attached.';
        if (cause instanceof ApiRequestError && cause.code === 'network') {
          reportConnectionError(message);
          /*
           * THE SAME KEY, AND THIS IS THE DANGEROUS CASE. The bytes may have
           * reached the server and the answer may have been lost on the way
           * back; the queue sends them again under the key this attempt used,
           * which the server replays rather than attaching twice.
           */
          const kept = await keep(
            file,
            key,
            context,
            'No connection to the EJE server. The photograph is kept on this tablet and is not on the job yet.',
          );
          if (kept) return false;
        }
        setError(message);
        setState('failed');
        return false;
      }
    },
    [invalidate, keep, online, reportConnectionError],
  );

  const send = useCallback(
    (file: File, context: TContext) => {
      const key = newIdempotencyKey();
      setCapture({ file, key, context });
      return run(file, key, context);
    },
    [run],
  );

  const retry = useCallback(() => {
    if (capture === null) return Promise.resolve(false);
    return run(capture.file, capture.key, capture.context);
  }, [capture, run]);

  const dismiss = useCallback(() => {
    setCapture(null);
    setState('idle');
    setError(null);
    setAttempts(0);
  }, []);

  return {
    state,
    error,
    fileName: capture?.file.name ?? null,
    attempts,
    send,
    retry,
    dismiss,
  };
};
