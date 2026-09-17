'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import {
  can,
  isJobOpenWork,
  JOB_STATUS_ORDER,
  jobStatusLabel,
  JOB_TYPE_CODES,
  jobTypeLabel,
  PRIORITY_ORDER,
  priorityLabel,
  priorityRank,
  type JobPriority,
  type JobStatus,
  type JobTypeCode,
} from '@/domain';
import { loadJobRows, type JobListRow } from '@/application/job-view';
import { Button, Card, ErrorState, Icon, LoadingPanel, SelectField } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { AcceptJobFlow } from '@/components/jobs/AcceptJobFlow';
import { JobListTable } from '@/components/jobs/JobListTable';
import { useQuery } from '@/hooks/useQuery';
import { useCurrentUser } from '@/providers/AppProvider';
import { isOverdue } from '@/lib/format';

type StatusFilter = JobStatus | 'all' | 'open-work' | 'awaiting_completion' | 'overdue';

const STATUS_OPTIONS: readonly { value: StatusFilter; label: string }[] = [
  { value: 'open-work', label: 'All open work' },
  { value: 'all', label: 'Every job' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'awaiting_completion', label: 'Awaiting completion' },
  ...JOB_STATUS_ORDER.map((status) => ({ value: status, label: jobStatusLabel(status) })),
];

const matchesStatus = (status: JobStatus, filter: StatusFilter, scheduled: string | null) => {
  switch (filter) {
    case 'all':
      return true;
    case 'open-work':
      return isJobOpenWork(status);
    case 'overdue':
      return isJobOpenWork(status) && isOverdue(scheduled);
    case 'awaiting_completion':
      return status === 'completion' || status === 'customer_signature' || status === 'review';
    default:
      return status === filter;
  }
};

const JobsPageContent = () => {
  const user = useCurrentUser();
  const params = useSearchParams();

  const [status, setStatus] = useState<StatusFilter>(
    (params.get('status') as StatusFilter | null) ?? 'open-work',
  );
  const [jobType, setJobType] = useState<JobTypeCode | 'all'>('all');
  const [priority, setPriority] = useState<JobPriority | 'all'>('all');
  const [mineOnly, setMineOnly] = useState(params.get('mine') === '1');
  const [term, setTerm] = useState('');
  const [accepting, setAccepting] = useState<JobListRow | null>(null);
  const isMaster = can(user.role, 'jobs.viewAll');

  const query = useQuery('jobs:list', async (repos) => {
    const jobs = await repos.jobs.list();
    return loadJobRows(repos, jobs);
  });

  const rows = useMemo(() => {
    const all = query.data ?? [];
    const needle = term.trim().toLowerCase();

    return all
      // A technician never sees cancelled work: it is history for the office,
      // and clutter on a tablet. Masters can still filter to it.
      .filter((row) => isMaster || row.job.status !== 'cancelled')
      .filter((row) => matchesStatus(row.job.status, status, row.job.scheduledDate))
      .filter((row) => jobType === 'all' || row.job.jobType === jobType)
      .filter((row) => priority === 'all' || row.job.priority === priority)
      .filter(
        (row) =>
          !mineOnly ||
          row.job.primaryTechnicianId === user.id ||
          row.job.additionalTechnicianIds.includes(user.id),
      )
      .filter(
        (row) =>
          needle.length === 0 ||
          row.job.jobNumber.toLowerCase().includes(needle) ||
          row.customerName.toLowerCase().includes(needle) ||
          row.siteName.toLowerCase().includes(needle) ||
          row.machineLabel.toLowerCase().includes(needle) ||
          row.machineSerial.toLowerCase().includes(needle) ||
          row.job.orderNumber.toLowerCase().includes(needle) ||
          row.job.referenceNumber.toLowerCase().includes(needle) ||
          row.job.faultDescription.toLowerCase().includes(needle),
      )
      .sort((a, b) => {
        const rank = priorityRank(a.job.priority) - priorityRank(b.job.priority);
        if (rank !== 0) return rank;
        return (a.job.scheduledDate ?? '9999').localeCompare(b.job.scheduledDate ?? '9999');
      });
  }, [query.data, status, jobType, priority, mineOnly, term, user.id, isMaster]);

  if (query.error !== null) {
    return <ErrorState message={query.error} onRetry={query.refetch} />;
  }

  return (
    <>
      <PageHeader
        title="Jobs"
        description="Every job card in the system, filtered the way you need it."
        breadcrumbs={[{ label: 'Jobs' }]}
        actions={
          <Link href="/jobs/new">
            <Button leadingIcon={<Icon name="plus" className="size-4" />}>New Job</Button>
          </Link>
        }
      />

      <Card className="mb-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <div className="xl:col-span-2">
            <label
              htmlFor="job-search"
              className="mb-1.5 block text-sm font-semibold text-steel-700"
            >
              Search
            </label>
            <div className="relative">
              <Icon
                name="search"
                className="pointer-events-none absolute top-1/2 left-3 size-[18px] -translate-y-1/2 text-steel-400"
              />
              <input
                id="job-search"
                type="search"
                value={term}
                onChange={(event) => setTerm(event.target.value)}
                placeholder="Job number, customer, serial, order number…"
                className="h-11 w-full rounded-[var(--radius-control)] border border-steel-300 bg-surface pr-3 pl-10 text-sm placeholder:text-steel-400 hover:border-steel-400 focus:border-eje-500 focus:ring-2 focus:ring-eje-100 focus:outline-none"
              />
            </div>
          </div>

          <SelectField
            label="Status"
            value={status}
            onChange={(event) => setStatus(event.target.value as StatusFilter)}
            options={STATUS_OPTIONS.map((option) => ({
              value: option.value,
              label: option.label,
            }))}
          />
          <SelectField
            label="Job type"
            value={jobType}
            onChange={(event) => setJobType(event.target.value as JobTypeCode | 'all')}
            options={[
              { value: 'all', label: 'All types' },
              ...JOB_TYPE_CODES.map((code) => ({ value: code, label: jobTypeLabel(code) })),
            ]}
          />
          <SelectField
            label="Priority"
            value={priority}
            onChange={(event) => setPriority(event.target.value as JobPriority | 'all')}
            options={[
              { value: 'all', label: 'All priorities' },
              ...PRIORITY_ORDER.map((value) => ({ value, label: priorityLabel(value) })),
            ]}
          />
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-steel-100 pt-4">
          <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm font-medium text-steel-700">
            <input
              type="checkbox"
              checked={mineOnly}
              onChange={(event) => setMineOnly(event.target.checked)}
              className="size-4.5 rounded border-steel-300 text-eje-600 focus:ring-eje-500"
            />
            Only jobs assigned to me
          </label>
          <p className="tabular text-sm text-steel-500">
            {query.loading ? 'Loading…' : `${rows.length} ${rows.length === 1 ? 'job' : 'jobs'}`}
          </p>
        </div>
      </Card>

      {query.loading ? (
        <LoadingPanel rows={6} label="Loading jobs" />
      ) : (
        <JobListTable rows={rows} onAccept={setAccepting} />
      )}

      {/* Accepting from the list uses the same flow as the job screen, so the
          site-location offer appears once and looks identical. */}
      {accepting !== null && (
        <AcceptJobFlow
          jobNumber={accepting.job.jobNumber}
          open
          onClose={() => setAccepting(null)}
          onAccepted={query.refetch}
        />
      )}
    </>
  );
};

const JobsPage = () => (
  <Suspense fallback={<LoadingPanel rows={6} label="Loading jobs" />}>
    <JobsPageContent />
  </Suspense>
);

export default JobsPage;
