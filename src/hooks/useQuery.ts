'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError, type ApiErrorCode } from '@/api/client';
import { useApp } from '@/providers/AppProvider';

export interface QueryResult<T> {
  readonly data: T | null;
  /** True only while there is nothing to show yet for this key. */
  readonly loading: boolean;
  /** True while a refresh is in flight but previous data is still on screen. */
  readonly refreshing: boolean;
  readonly error: string | null;
  /**
   * WHY the read failed, not merely that it did.
   *
   * Without this every failure reached the screen as a sentence, and a screen
   * with only a sentence has one thing it can draw: "Something went wrong. Try
   * again." A 403 is not a fault and retrying it will refuse again — see
   * `describeFailure`, which is what turns this into what the person is told.
   *
   * Null when the failure was not an API refusal at all (a loader that threw on
   * its own), which is a genuine fault and is presented as one.
   */
  readonly errorCode: ApiErrorCode | null;
  refetch(): void;
}

interface Settled<T> {
  readonly key: string;
  readonly token: string;
  readonly data: T | null;
  readonly error: string | null;
  readonly errorCode: ApiErrorCode | null;
}

/**
 * Minimal async data hook over the API.
 *
 * The loader now takes NOTHING: it calls `@/api/endpoints`, which calls the
 * server, which decides what this actor may have. Previously it was handed a
 * `RepositoryBundle` and read the data directly in the browser — which is what
 * made the browser a participant in authorisation rather than a consumer of it.
 *
 * The three re-run triggers are unchanged: the key changes, a write bumps the
 * version, or `refetch` is called. So is the distinction the screens depend on:
 *
 *  - `loading` — nothing has resolved for this key yet, so show a skeleton.
 *  - `refreshing` — a write has invalidated the data but the previous result is
 *    still valid to display.
 *
 * Without the second, every capture on a job card would tear the screen down to
 * a skeleton and lose the state of any open panel.
 */
export const useQuery = <T,>(key: string, loader: () => Promise<T>): QueryResult<T> => {
  const { version } = useApp();
  const [nonce, setNonce] = useState(0);
  const token = `${key}::${version}::${nonce}`;

  const [settled, setSettled] = useState<Settled<T>>({
    key: '',
    token: '',
    data: null,
    error: null,
    errorCode: null,
  });

  // The loader is a fresh closure on every render. Keeping it in a ref that is
  // only ever updated in an effect (never during render) means the query does
  // not re-run merely because the component re-rendered.
  const loaderRef = useRef(loader);
  useEffect(() => {
    loaderRef.current = loader;
  });

  useEffect(() => {
    let cancelled = false;

    loaderRef
      .current()
      .then((result) => {
        if (!cancelled) setSettled({ key, token, data: result, error: null, errorCode: null });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setSettled({
          key,
          token,
          data: null,
          error: cause instanceof Error ? cause.message : 'Unable to load this data.',
          errorCode: cause instanceof ApiRequestError ? cause.code : null,
        });
      });

    return () => {
      cancelled = true;
    };
    // `token` already encodes `key`; listing it as a dependency would be redundant.
  }, [key, token]);

  const refetch = useCallback(() => setNonce((current) => current + 1), []);

  const current = settled.token === token;
  const sameKey = settled.key === key;

  return {
    data: sameKey ? settled.data : null,
    loading: !sameKey,
    refreshing: sameKey && !current,
    error: sameKey && current ? settled.error : null,
    errorCode: sameKey && current ? settled.errorCode : null,
    refetch,
  };
};
