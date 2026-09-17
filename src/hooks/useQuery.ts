'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RepositoryBundle } from '@/data/repositories';
import { useApp } from '@/providers/AppProvider';

export interface QueryResult<T> {
  readonly data: T | null;
  readonly loading: boolean;
  readonly error: string | null;
  refetch(): void;
}

/**
 * Minimal async data hook over the repository layer.
 *
 * `key` identifies the query; the hook re-runs whenever the key changes or a
 * write bumps the store version. In Phase 2 this is replaced by a real query
 * cache (React Query or SWR) with the same call shape at the call sites.
 */
export const useQuery = <T,>(
  key: string,
  loader: (repos: RepositoryBundle) => Promise<T>,
): QueryResult<T> => {
  const { repositories, version } = useApp();
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    loaderRef
      .current(repositories)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : 'Unable to load this data.');
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [key, version, nonce, repositories]);

  const refetch = useCallback(() => setNonce((current) => current + 1), []);

  return { data, loading, error, refetch };
};
