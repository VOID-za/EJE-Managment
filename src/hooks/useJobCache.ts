'use client';

import { useEffect, useState } from 'react';
import type { JobListRow } from '@/application/job-view';
import {
  describeCacheStatus,
  type CacheStatus,
} from '@/lib/pwa/cache-state';
import {
  cacheJobsFor,
  isJobCacheSupported,
  readCacheMeta,
  readCachedJobs,
} from '@/lib/pwa/job-cache';
import type { CachedJob } from '@/lib/pwa/cached-job';
import { useCurrentUser } from '@/providers/AppProvider';
import { useOnline } from '@/hooks/useOnline';

/**
 * THE JOB LIST, KEPT FOR THE TIMES THERE IS NO SIGNAL. PWA-6.
 *
 * Write-through and read-on-failure, which is the whole of it:
 *
 *   - a successful read is stored, narrowed to `CachedJob` first, under the
 *     signed-in user's id;
 *   - a failed read falls back to what that user has stored, clearly labelled
 *     with when it arrived;
 *   - a failure NEVER empties the cache. The last good copy is the thing of
 *     value here, and throwing it away because the yard has no signal is the
 *     one unforgivable behaviour for a cache on a field device.
 *
 * It returns a status rather than a boolean so the screen cannot accidentally
 * present yesterday's list as today's — see `describeCacheStatus`.
 */
export interface JobCacheResult {
  /** Cached rows, for when the server could not be reached. */
  readonly cached: readonly CachedJob[];
  readonly status: CacheStatus;
  /** True where this browser cannot cache at all (no IndexedDB). */
  readonly supported: boolean;
}

/**
 * What this device holds for one user, or nothing at all.
 *
 * Always asynchronous, including the "there is nothing to read" paths: the
 * caller is an effect, and an effect that sets state before it yields makes
 * React render twice for one event.
 */
const readCacheFor = async (
  userId: string,
): Promise<{ readonly jobs: readonly CachedJob[]; readonly lastRefreshedAt: string | null }> => {
  if (userId.length === 0 || !isJobCacheSupported()) return { jobs: [], lastRefreshedAt: null };
  const [jobs, meta] = await Promise.all([readCachedJobs(userId), readCacheMeta(userId)]);
  return { jobs, lastRefreshedAt: meta?.lastRefreshedAt ?? null };
};

export const useJobCache = (input: {
  readonly rows: readonly JobListRow[] | null;
  readonly loading: boolean;
  readonly refreshing: boolean;
  readonly failed: boolean;
}): JobCacheResult => {
  const currentUser = useCurrentUser();
  const userId = currentUser?.id ?? '';

  const [cached, setCached] = useState<readonly CachedJob[]>([]);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
  const online = useOnline();

  /*
   * Signed out, or somebody else signed in: nothing of the previous user's is
   * left on screen, because `readCacheFor('')` reads nothing. The store itself
   * is emptied by the session (`AppProvider`), not by this hook — a screen
   * unmounting is not a reason to throw away a field device's only copy.
   */
  useEffect(() => {
    let cancelled = false;
    void readCacheFor(userId).then((state) => {
      if (cancelled) return;
      setCached(state.jobs);
      setLastRefreshedAt(state.lastRefreshedAt);
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const rows = input.rows;
  useEffect(() => {
    if (rows === null || userId.length === 0 || !isJobCacheSupported()) return;
    const refreshedAt = new Date().toISOString();
    void cacheJobsFor(userId, rows, refreshedAt)
      .then(() => {
        setLastRefreshedAt(refreshedAt);
        return readCachedJobs(userId);
      })
      .then((stored) => setCached(stored))
      .catch(() => {
        /*
         * A cache that cannot be written is not a reason to fail the screen:
         * the server's answer is already on it. The status keeps saying when
         * this device last stored a copy, which is still true.
         */
      });
  }, [rows, userId]);

  return {
    cached,
    supported: isJobCacheSupported(),
    status: describeCacheStatus({
      online,
      refreshing: input.refreshing || (input.loading && lastRefreshedAt !== null),
      signedIn: userId.length > 0,
      lastRefreshedAt,
      lastRefreshFailed: input.failed,
      hasCachedCopy: cached.length > 0,
    }),
  };
};
