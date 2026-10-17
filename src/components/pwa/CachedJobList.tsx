'use client';

import { Card, EmptyState } from '@/components/ui';
import type { CachedJob } from '@/lib/pwa/cached-job';

/**
 * THE JOBS THIS TABLET REMEMBERS. PWA-6.
 *
 * Deliberately NOT the ordinary job table. That table is interactive — accept,
 * open, capture — and every one of those actions needs the server. Offering
 * them against a cached record would promise something this screen cannot do,
 * so this is a reading list: what the job is, where it is, what is wrong with
 * it. Tapping is for when there is signal.
 *
 * Nothing here is authority. The records are what the server last said, and
 * the server is asked again the moment it can be reached.
 */
export const CachedJobList = ({ jobs }: { readonly jobs: readonly CachedJob[] }) => {
  if (jobs.length === 0) {
    return (
      <EmptyState
        title="No cached jobs on this tablet"
        description="Your jobs are loaded when the application can reach the EJE server. Nothing has been stored on this device yet."
      />
    );
  }

  return (
    <ul className="space-y-2" data-testid="cached-job-list">
      {jobs.map((job) => (
        <li key={job.jobNumber}>
          <Card className="p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="font-mono text-sm font-semibold">{job.jobNumber}</span>
              <span className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                {job.status.replace(/_/gu, ' ')} · {job.priority}
              </span>
            </div>
            <p className="mt-1 text-sm font-medium">
              {job.customerName} — {job.siteName}
            </p>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {job.machineLabel}
              {job.machineSerial.length > 0 ? ` · ${job.machineSerial}` : ''}
            </p>
            {job.faultDescription.length > 0 && (
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                {job.faultDescription}
              </p>
            )}
            {job.scheduledDate !== null && (
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Scheduled {job.scheduledDate}
              </p>
            )}
          </Card>
        </li>
      ))}
    </ul>
  );
};
