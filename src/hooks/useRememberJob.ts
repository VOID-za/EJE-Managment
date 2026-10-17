'use client';

import { useEffect } from 'react';
import { isJobCacheSupported, rememberLastPlace } from '@/lib/pwa/job-cache';
import { useCurrentUser } from '@/providers/AppProvider';

/**
 * Remembers that this technician is on this job. PWA-4.
 *
 * One record per user, overwritten on every job they open, cleared with the
 * rest of the cache when a session ends. It is a job NUMBER and a timestamp —
 * no captured work, because there is no local draft in Phase 3 and a hook that
 * implied otherwise would be the first step towards one nobody scoped.
 *
 * A failure is swallowed deliberately: being unable to record where somebody
 * was must never interfere with the job they are standing in front of.
 */
export const useRememberJob = (jobNumber: string): void => {
  const currentUser = useCurrentUser();
  const userId = currentUser?.id ?? '';

  useEffect(() => {
    if (userId.length === 0 || jobNumber.length === 0 || !isJobCacheSupported()) return;
    void rememberLastPlace(userId, jobNumber).catch(() => undefined);
  }, [userId, jobNumber]);
};
