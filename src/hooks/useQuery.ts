'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RepositoryBundle } from '@/data/repositories';
import { useApp } from '@/providers/AppProvider';

export interface QueryResult<T> {
  readonly data: T | null;
  /** True only while there is nothing to show yet for this key. */
  readonly loading: boolean;
  /** True while a refresh is in flight but previous data is still on screen. */
  readonly refreshing: boolean;
  readonly error: string | null;
  refetch(): void;
}

interface Settled<T> {
  readonly key: string;
  readonly token: string;
  readonly data: T | null;
  readonly error: string | null;
}

/**
 * Minimal async data hook over the repository layer.
 *
 * The query re-runs when `key` changes, when a write bumps the store version,
 * or when `refetch` is called; those three form the token. Two distinct states
 * fall out of comparing the settled result against the current request:
 *
 *  - `loading` — nothing has resolved for this key yet, so show a skeleton.
 *  - `refreshing` — a write has invalidated the data but the previous result is
 *    still valid to display.
 *
 * The distinction matters: without it, every capture on a job card would tear
 * the whole screen down to a skeleton and lose the state of any open panel.
 * This is stale-while-revalidate, and it is exactly what the Phase 2 query cache
 * will do at the same call sites.
 */
export const useQuery = <T,>(
  key: string,
  loader: (repos: RepositoryBundle) => Promise<T>,
): QueryResult<T> => {
  const { repositories, version } = useApp();
  const [nonce, setNonce] = useState(0);
  const token = `${key}::${version}::${nonce}`;

  const [settled, setSettled] = useState<Settled<T>>({
    key: '',
    token: '',
    data: null,
    error: null,
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
      .current(repositories)
      .then((result) => {
        if (!cancelled) setSettled({ key, token, data: result, error: null });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setSettled({
          key,
          token,
          data: null,
          error: cause instanceof Error ? cause.message : 'Unable to load this data.',
        });
      });

    return () => {
      cancelled = true;
    };
    // `token` already encodes `key`; listing it as a dependency would be redundant.
  }, [key, token, repositories]);

  const refetch = useCallback(() => setNonce((current) => current + 1), []);

  const current = settled.token === token;
  const sameKey = settled.key === key;

  return {
    data: sameKey ? settled.data : null,
    loading: !sameKey,
    refreshing: sameKey && !current,
    error: sameKey && current ? settled.error : null,
    refetch,
  };
};
