'use client';

import { useRouter } from 'next/navigation';
import type { JobListRow } from '@/application/job-view';
import { Avatar, DataTable, Icon, JobStatusBadge, PriorityBadge, type Column } from '@/components/ui';
import { formatDate, isOverdue } from '@/lib/format';
import { JobTypeChip } from './JobTypeChip';
import { cn } from '@/lib/cn';

export interface JobListTableProps {
  readonly rows: readonly JobListRow[];
  readonly emptyTitle?: string;
  readonly emptyDescription?: string;
  readonly showTechnician?: boolean;
}

export const JobListTable = ({
  rows,
  emptyTitle,
  emptyDescription,
  showTechnician = true,
}: JobListTableProps) => {
  const router = useRouter();

  const columns: Column<JobListRow>[] = [
    {
      key: 'jobNumber',
      header: 'Job',
      width: '190px',
      render: (row) => (
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-semibold whitespace-nowrap text-steel-900">
            {row.job.jobNumber}
          </span>
          {row.job.priority === 'urgent' && <PriorityBadge priority="urgent" size="sm" />}
        </div>
      ),
    },
    {
      key: 'customer',
      header: 'Customer / Site',
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-steel-900">{row.customerName}</p>
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
          <p className="truncate text-steel-800">{row.machineLabel}</p>
          <p className="truncate font-mono text-xs text-steel-500">{row.machineSerial}</p>
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      render: (row) => <JobTypeChip jobType={row.job.jobType} size="sm" />,
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => <JobStatusBadge status={row.job.status} size="sm" />,
    },
    {
      key: 'scheduled',
      header: 'Scheduled',
      secondary: true,
      render: (row) => {
        const overdue =
          isOverdue(row.job.scheduledDate) &&
          row.job.status !== 'closed' &&
          row.job.status !== 'submitted';
        return (
          <span
            className={cn(
              'tabular inline-flex items-center gap-1.5 text-sm',
              overdue ? 'font-semibold text-signal-600' : 'text-steel-600',
            )}
          >
            {overdue && <Icon name="warning" className="size-3.5" />}
            {formatDate(row.job.scheduledDate)}
          </span>
        );
      },
    },
    ...(showTechnician
      ? [
          {
            key: 'technician',
            header: 'Technician',
            render: (row: JobListRow) => (
              <div className="flex items-center gap-2">
                {row.technicianInitials === '—' ? (
                  <span className="text-xs text-steel-400 italic">Unassigned</span>
                ) : (
                  <>
                    <Avatar initials={row.technicianInitials} size="sm" />
                    <span className="hidden truncate text-sm text-steel-700 xl:inline">
                      {row.technicianName}
                    </span>
                  </>
                )}
              </div>
            ),
          } satisfies Column<JobListRow>,
        ]
      : []),
    {
      key: 'chevron',
      header: '',
      align: 'right',
      width: '48px',
      render: () => <Icon name="chevronRight" className="size-4 text-steel-300" />,
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(row) => row.job.id}
      onRowClick={(row) => router.push(`/jobs/${row.job.jobNumber}`)}
      emptyTitle={emptyTitle ?? 'No jobs found'}
      emptyDescription={
        emptyDescription ?? 'No jobs match the current filters. Try widening your selection.'
      }
    />
  );
};
