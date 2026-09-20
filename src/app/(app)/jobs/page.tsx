'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import {
  can,
  isJobOpenWork,
  JOB_STATUS_ORDER,
  jobStatusLabel,
  statusMatches,
  JOB_TYPE_CODES,
  jobTypeLabel,
  PRIORITY_ORDER,
  refusalAwaitingResolution,
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
import { cn } from '@/lib/cn';
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

/**
 * The five lists the office actually asks for by name.
 *
 * They set the same status filter the dropdown does, rather than being a
 * parallel mechanism — except Closed, which leaves for the archive, because a
 * closed job is a historical record with its own search, not a row in the
 * working list.
 */
const QUICK_FILTERS: readonly { readonly value: StatusFilter; readonly label: string }[] = [
  { value: 'open-work', label: 'Open work' },
  { value: 'open', label: 'Open' },
  { value: 'awaiting_spares', label: 'Awaiting spares' },
  // Issued and waiting on the customer's copy arriving — the live stage that
  // actually holds jobs up, and the one the office chases.
  { value: 'awaiting_delivery', label: 'Awaiting delivery' },
  { value: 'cancelled', label: 'Cancelled' },
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
      // `statusMatches` rather than equality, so a historical Master Review
      // job is listed under Review, which is what it is labelled.
      return statusMatches(status, filter);
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
  /*
   * The refusal queue, entered from the dashboard tile.
   *
   * A filter over the ordinary job list rather than a page of its own: these
   * are normal jobs at Review with an exception on them, and the office needs
   * the same columns, the same search and the same actions it always has.
   */
  const [refusalsOnly, setRefusalsOnly] = useState(
    params.get('signatureRefusal') === 'unresolved',
  );
  const [term, setTerm] = useState('');
  const [accepting, setAccepting] = useState<JobListRow | null>(null);
  const isMaster = can(user.role, 'jobs.viewAll');

  const query = useQuery('jobs:list', async (repos) => {
    const jobs = await repos.jobs.list();
    return loadJobRows(repos, jobs, user);
  });

  const rows = useMemo(() => {
    const all = query.data ?? [];
    const needle = term.trim().toLowerCase();

    return all
      // A technician never sees cancelled work: it is history for the office,
      // and clutter on a tablet. Masters can still filter to it.
      .filter((row) => isMaster || row.job.status !== 'cancelled')
      .filter((row) => (refusalsOnly ? refusalAwaitingResolution(row.job) : true))
      .filter((row) =>
        // The refusal queue is a queue, not a status: it ignores the status
        // filter entirely rather than intersecting with whatever was selected.
        refusalsOnly ? true : matchesStatus(row.job.status, status, row.job.scheduledDate),
      )
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
  }, [query.data, status, jobType, priority, mineOnly, refusalsOnly, term, user.id, isMaster]);

  // Counted over everything this user may see, so a quick filter can say how
  // many are behind it before it is pressed.
  const visible = useMemo(
    () => (query.data ?? []).filter((row) => isMaster || row.job.status !== 'cancelled'),
    [query.data, isMaster],
  );
  const quickCount = (filter: StatusFilter): number =>
    visible.filter((row) => matchesStatus(row.job.status, filter, row.job.scheduledDate)).length;
  const closedCount = visible.filter((row) => row.job.status === 'closed').length;
  const refusalCount = visible.filter((row) => refusalAwaitingResolution(row.job)).length;
  const canSeeRefusalQueue = can(user.role, 'jobs.viewAnySignatureRefusal');

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

      <div className="eje-scrollbar mb-4 flex flex-wrap items-center gap-2">
        {/* The office's exception queue, beside the working lists it belongs
            with. Hidden from technicians, who have no global view of other
            people's refusals. */}
        {canSeeRefusalQueue && (
          <button
            type="button"
            onClick={() => setRefusalsOnly((current) => !current)}
            aria-pressed={refusalsOnly}
            className={cn(
              'inline-flex min-h-9 items-center gap-2 rounded-full border px-3.5 text-sm font-medium transition-colors',
              refusalsOnly
                ? 'border-signal-500 bg-signal-600 text-white'
                : 'border-signal-300 bg-signal-50 text-signal-700 hover:border-signal-400',
            )}
          >
            <Icon name="warning" className="size-4" />
            Signature refusals
            <span
              className={cn(
                'tabular rounded-full px-1.5 text-xs',
                refusalsOnly ? 'bg-white/20' : 'bg-white text-signal-700',
              )}
            >
              {query.loading ? '—' : refusalCount}
            </span>
          </button>
        )}

        {QUICK_FILTERS.filter((filter) => isMaster || filter.value !== 'cancelled').map(
          (filter) => (
            <button
              key={filter.value}
              type="button"
              onClick={() => {
                setRefusalsOnly(false);
                setStatus(filter.value);
              }}
              aria-pressed={!refusalsOnly && status === filter.value}
              className={cn(
                'inline-flex min-h-9 items-center gap-2 rounded-full border px-3.5 text-sm font-medium transition-colors',
                !refusalsOnly && status === filter.value
                  ? 'border-eje-500 bg-eje-600 text-white'
                  : 'border-steel-300 bg-surface text-steel-700 hover:border-steel-400',
              )}
            >
              {filter.label}
              <span
                className={cn(
                  'tabular rounded-full px-1.5 text-xs',
                  !refusalsOnly && status === filter.value
                    ? 'bg-white/20'
                    : 'bg-steel-100 text-steel-600',
                )}
              >
                {query.loading ? '—' : quickCount(filter.value)}
              </span>
            </button>
          ),
        )}

        {/* Closed work leaves for the archive: it is a historical record with
            its own search, not another row in the working list. */}
        {isMaster && (
          <Link
            href="/jobs/closed"
            className="inline-flex min-h-9 items-center gap-2 rounded-full border border-steel-300 bg-surface px-3.5 text-sm font-medium text-steel-700 transition-colors hover:border-steel-400"
          >
            <Icon name="document" className="size-4 text-steel-400" />
            Closed Jobs
            <span className="tabular rounded-full bg-steel-100 px-1.5 text-xs text-steel-600">
              {query.loading ? '—' : closedCount}
            </span>
          </Link>
        )}
      </div>

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
        <JobListTable rows={rows} onAccept={setAccepting} showRefusal={refusalsOnly} />
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
