'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import {
  JOB_TYPE_CODES,
  can,
  jobTypeLabel,
  userFullName,
  type JobTypeCode,
} from '@/domain';
import {
  CLOSED_JOBS_PAGE_SIZE,
  emptyClosedJobFilters,
  loadClosedJobs,
  type ClosedJobFilters,
} from '@/application/closed-jobs';
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  Icon,
  LoadingPanel,
  SelectField,
  TextField,
  type Column,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { JobTypeChip } from '@/components/jobs/JobTypeChip';
import { useQuery } from '@/hooks/useQuery';
import { useCurrentUser } from '@/providers/AppProvider';
import { formatDate } from '@/lib/format';
import type { JobListRow } from '@/application/job-view';

/**
 * Closed Jobs — the job card archive.
 *
 * The answer to "where does a Master go to find a closed job and download its
 * card?". Every closed job, searchable by whatever the office actually
 * remembers: a job number, a customer, a serial number, a purchase order.
 *
 * Read-only by design. A closed job is a historical record, so this screen
 * opens it and never offers to edit it.
 */
const ClosedJobsPage = () => {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const [filters, setFilters] = useState<ClosedJobFilters>(emptyClosedJobFilters);

  const canView = can(currentUser.role, 'jobs.viewAll');

  const query = useQuery(
    `closed-jobs:${JSON.stringify(filters)}`,
    (repos) => loadClosedJobs(repos, filters),
  );

  const set = <K extends keyof ClosedJobFilters>(key: K, value: ClosedJobFilters[K]): void =>
    setFilters((current) => ({ ...current, [key]: value }));

  const data = query.data;

  // Sites narrow to the chosen customer, so the filter is usable rather than a
  // list of every site EJE has.
  const sites = useMemo(() => {
    const all = data?.sites ?? [];
    return filters.customerId === 'all'
      ? all
      : all.filter((site) => site.customerId === filters.customerId);
  }, [data, filters.customerId]);

  if (!canView) {
    return (
      <EmptyState
        title="Closed Jobs is a Master screen"
        description="Historical jobs are reached through the customer, site or machine you are working on."
        icon={<Icon name="document" />}
      />
    );
  }

  if (query.error !== null) {
    return <ErrorState message={query.error} onRetry={query.refetch} />;
  }

  const columns: Column<JobListRow>[] = [
    {
      key: 'jobNumber',
      header: 'Job',
      width: '150px',
      render: (row) => (
        <div className="min-w-0">
          <span className="font-mono text-sm font-semibold whitespace-nowrap text-steel-900">
            {row.job.jobNumber}
          </span>
          <span className="block text-xs text-steel-400 lg:hidden">{row.customerName}</span>
        </div>
      ),
    },
    {
      key: 'customer',
      header: 'Customer / Site',
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate text-sm text-steel-800">{row.customerName}</p>
          <p className="truncate text-xs text-steel-500">{row.siteName}</p>
        </div>
      ),
    },
    {
      key: 'machine',
      header: 'Machine',
      secondary: true,
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate text-sm text-steel-700">{row.machineLabel}</p>
          <p className="truncate font-mono text-xs text-steel-400">{row.machineSerial}</p>
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      width: '130px',
      render: (row) => <JobTypeChip jobType={row.job.jobType} />,
    },
    {
      key: 'technician',
      header: 'Technician',
      secondary: true,
      render: (row) => <span className="text-sm text-steel-700">{row.technicianName}</span>,
    },
    {
      key: 'closed',
      header: 'Closed',
      width: '120px',
      render: (row) => (
        <span className="tabular text-sm text-steel-700">
          {row.job.closedAt === null ? '—' : formatDate(row.job.closedAt)}
        </span>
      ),
    },
    {
      key: 'references',
      header: 'Order / Ref',
      secondary: true,
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate text-xs text-steel-600">
            {row.job.orderNumber.length > 0 ? row.job.orderNumber : '—'}
          </p>
          <p className="truncate text-xs text-steel-400">
            {row.job.referenceNumber.length > 0 ? row.job.referenceNumber : '—'}
          </p>
        </div>
      ),
    },
    {
      key: 'card',
      header: '',
      align: 'right',
      width: '56px',
      render: (row) =>
        row.job.finalDocument === null ? (
          <Icon name="chevronRight" className="size-4 text-steel-300" />
        ) : (
          <Icon
            name="document"
            className="size-4 text-steel-400"
            aria-label="Final job card available"
          />
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Closed Jobs"
        breadcrumbs={[{ label: 'Jobs', href: '/jobs' }, { label: 'Closed Jobs' }]}
        description="Every issued and closed job card. Historical records — read-only, with the final signed document against each one."
      />

      <Card className="mb-5">
        <TextField
          label="Search the archive"
          value={filters.term}
          onChange={(event) => set('term', event.target.value)}
          placeholder="Job number, customer, site, machine, serial number, order or reference"
          hint="Searches every one of those fields, so you do not have to remember the job number."
        />

        <div className="mt-4 grid grid-cols-1 gap-4 border-t border-steel-100 pt-4 sm:grid-cols-2 lg:grid-cols-3">
          <SelectField
            label="Customer"
            value={filters.customerId}
            onChange={(event) => {
              set('customerId', event.target.value);
              // A site from another customer would filter everything away.
              set('siteId', 'all');
            }}
            options={[
              { value: 'all', label: 'All customers' },
              ...(data?.customers ?? []).map((customer) => ({
                value: customer.id,
                label: customer.name,
              })),
            ]}
          />
          <SelectField
            label="Site"
            value={filters.siteId}
            onChange={(event) => set('siteId', event.target.value)}
            options={[
              { value: 'all', label: 'All sites' },
              ...sites.map((site) => ({ value: site.id, label: site.name })),
            ]}
          />
          <SelectField
            label="Job type"
            value={filters.jobType}
            onChange={(event) => set('jobType', event.target.value as JobTypeCode | 'all')}
            options={[
              { value: 'all', label: 'All types' },
              ...JOB_TYPE_CODES.map((code) => ({ value: code, label: jobTypeLabel(code) })),
            ]}
          />
          <SelectField
            label="Technician"
            value={filters.technicianId}
            onChange={(event) => set('technicianId', event.target.value)}
            options={[
              { value: 'all', label: 'All technicians' },
              ...(data?.technicians ?? []).map((technician) => ({
                value: technician.id,
                label: userFullName(technician),
              })),
            ]}
          />
          <TextField
            label="Closed from"
            type="date"
            value={filters.closedFrom}
            onChange={(event) => set('closedFrom', event.target.value)}
          />
          <TextField
            label="Closed to"
            type="date"
            value={filters.closedTo}
            onChange={(event) => set('closedTo', event.target.value)}
          />
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-steel-100 pt-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFilters(emptyClosedJobFilters)}
            disabled={JSON.stringify(filters) === JSON.stringify(emptyClosedJobFilters)}
          >
            Clear filters
          </Button>
          <p className="tabular text-sm text-steel-500">
            {query.loading
              ? 'Searching…'
              : `${data?.matched ?? 0} closed ${(data?.matched ?? 0) === 1 ? 'job' : 'jobs'}`}
            {data?.truncated === true && (
              <>
                {' '}
                <Badge tone="amber" size="sm">
                  showing the most recent {CLOSED_JOBS_PAGE_SIZE}
                </Badge>
              </>
            )}
          </p>
        </div>
      </Card>

      {query.loading && data === undefined ? (
        <LoadingPanel rows={6} label="Loading closed jobs" />
      ) : (
        <DataTable
          columns={columns}
          rows={data?.rows ?? []}
          rowKey={(row) => row.job.id}
          onRowClick={(row) => router.push(`/jobs/${row.job.jobNumber}`)}
          emptyTitle="No closed jobs match"
          emptyDescription="Widen the search, or clear the filters to see the whole archive."
        />
      )}
    </>
  );
};

export default ClosedJobsPage;
