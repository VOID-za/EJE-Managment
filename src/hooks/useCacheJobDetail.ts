'use client';

import { useEffect } from 'react';
import {
  evaluateChecklist,
  getJobTypeDefinition,
  siteAddressLine,
  machineDisplayName,
  type Job,
} from '@/domain';
import type { JobView } from '@/application/job-view';
import { cacheJobDetail, isJobCacheSupported } from '@/lib/pwa/job-cache';
import { toCachedJobDetail } from '@/lib/pwa/cached-job';
import { useCurrentUser } from '@/providers/AppProvider';

/**
 * KEEPS THIS JOB'S DETAIL ON THE DEVICE, FOR WHEN THERE IS NO SIGNAL.
 * OFF-DETAIL-1.
 *
 * Written when the SERVER has answered — so the copy is only ever of something
 * this user was entitled to read a moment ago, and the authorisation is the
 * server's, never the device's. Narrowed by `toCachedJobDetail`, which is
 * where the list of what may be kept lives.
 *
 * Called from the job screen for the same reason `useRememberJob` is: a flat
 * battery, a locked tablet and a launcher reclaiming memory all run no code on
 * the way out, so the moment to write is on the way IN.
 *
 * ONLY FOR SOMEBODY WHO DOES FIELD WORK ON THIS JOB. The office reads these
 * screens at a desk with a connection; caching a customer's job detail on
 * every machine that opens it would be a copy nobody needs. The technician on
 * the job is the person who loses coverage while standing at the machine.
 */
export const useCacheJobDetail = (view: JobView | null, mine: boolean): void => {
  const currentUser = useCurrentUser();
  const userId = currentUser?.id ?? '';

  useEffect(() => {
    if (!mine || view === null || userId.length === 0 || !isJobCacheSupported()) return;

    const job: Job = view.job;
    const progress =
      view.checklistTemplate === null
        ? null
        : evaluateChecklist(view.checklistTemplate, job.checklist);

    void cacheJobDetail(
      toCachedJobDetail(
        userId,
        {
          job,
          customerName: view.customer.name,
          siteName: view.site.name,
          siteAddress: siteAddressLine(view.site),
          machineLabel: view.machine === null ? '' : machineDisplayName(view.machine),
          machineSerial: view.machine?.serialNumber ?? '',
          signed: job.signature !== null,
          capturesLabourAndTravel: getJobTypeDefinition(job.jobType).capturesLabourAndTravel,
          checklist:
            progress === null || view.checklistTemplate === null
              ? null
              : {
                  name: view.checklistTemplate.name,
                  templateVersion: view.checklistTemplate.version,
                  answered: progress.answered,
                  total: progress.total,
                  completed: job.checklist?.completedAt !== null && job.checklist !== null,
                  /*
                   * What is still outstanding, in the template's own words —
                   * the one thing a technician with no signal cannot work out
                   * for themselves, and the reason this cache exists.
                   */
                  outstanding: progress.issues.map((issue) => issue.message).slice(0, 30),
                },
        },
        new Date().toISOString(),
      ),
    ).catch(() => undefined);
    // Keyed on what the copy would SAY: a re-render with the same job writes
    // nothing new, and a capture that changed it writes again.
  }, [view, mine, userId]);
};
