'use client';

import { useRouter } from 'next/navigation';
import type { JobListRow } from '@/application/job-view';
import {
  Avatar,
  Badge,
  Button,
  DataTable,
  Icon,
  JobStatusBadge,
  PriorityBadge,
  type Column,
} from '@/components/ui';
import {
  canAcceptJob,
  currentRefusal,
  jobScheduleWindow,
  refusalAwaitingResolution,
} from '@/domain';
import { formatDate, isOverdue } from '@/lib/format';
import { JobTypeChip } from './JobTypeChip';
import { cn } from '@/lib/cn';

export interface JobListTableProps {
  readonly rows: readonly JobListRow[];
  readonly emptyTitle?: string;
  readonly emptyDescription?: string;
  readonly showTechnician?: boolean;
  /**
   * Offers Accept in the row for jobs the viewer may take.
   *
   * Acceptance from the list goes through the same `AcceptJobFlow` as the job
   * screen, so the site-location offer appears exactly once and behaves the
   * same either way.
   */
  readonly onAccept?: (row: JobListRow) => void;
  /**
   * Replaces the Scheduled column with the refusal and its date.
   *
   * For the office's refusal queue, where "when was this scheduled" is not the
   * question — "when did the customer turn it away, and has anyone dealt with
   * it" is.
   */
  readonly showRefusal?: boolean;
}

export const JobListTable = ({
  rows,
  emptyTitle,
  emptyDescription,
  showTechnician = true,
  onAccept,
  showRefusal = false,
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
      render: (row) => (
        <div className="flex flex-wrap items-center gap-1.5">
          <JobStatusBadge status={row.job.status} size="sm" />
          {/* The exception, wherever the job is listed. The status stays what
              it is — Review — and this says what happened at the signature. */}
          {refusalAwaitingResolution(row.job) && (
            <Badge tone="red" size="sm" dot>
              Refused
            </Badge>
          )}
        </div>
      ),
    },
    ...(showRefusal
      ? [
          {
            key: 'refusal',
            header: 'Refused',
            secondary: true,
            render: (row: JobListRow) => {
              const refusal = currentRefusal(row.job);
              if (refusal === null) return <span className="text-steel-400">—</span>;
              return (
                <div className="min-w-0">
                  <span className="block text-sm whitespace-nowrap text-steel-700">
                    {formatDate(refusal.recordedAt)}
                  </span>
                  <span className="block truncate text-xs text-steel-500">{refusal.reason}</span>
                </div>
              );
            },
          },
        ]
      : []),
    {
      key: 'scheduled',
      header: 'Scheduled',
      secondary: true,
      render: (row) => {
        const overdue =
          isOverdue(row.job.scheduledDate) &&
          row.job.status !== 'closed' &&
          row.job.status !== 'submitted';
        const window = jobScheduleWindow(row.job);
        return (
          <span
            className={cn(
              'tabular inline-flex items-center gap-1.5 text-sm whitespace-nowrap',
              overdue ? 'font-semibold text-signal-600' : 'text-steel-600',
            )}
          >
            {overdue && <Icon name="warning" className="size-3.5" />}
            {formatDate(row.job.scheduledDate)}
            {window !== null && window.days > 1 && (
              <span className="text-xs text-steel-400">+{window.days - 1}d</span>
            )}
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
    ...(onAccept !== undefined
      ? [
          {
            key: 'accept',
            header: '',
            align: 'right' as const,
            width: '120px',
            render: (row: JobListRow) =>
              canAcceptJob(row.job) ? (
                <Button
                  size="sm"
                  onClick={(event) => {
                    // The row itself navigates, so accepting must not also open
                    // the job underneath the dialog.
                    event.stopPropagation();
                    onAccept(row);
                  }}
                >
                  Accept
                </Button>
              ) : null,
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
