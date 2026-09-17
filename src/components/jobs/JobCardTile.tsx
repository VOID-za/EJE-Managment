import Link from 'next/link';
import type { JobListRow } from '@/application/job-view';
import { Avatar, Icon, JobStatusBadge, PriorityBadge } from '@/components/ui';
import { formatDate, isOverdue, isToday } from '@/lib/format';
import { cn } from '@/lib/cn';
import { JobTypeChip } from './JobTypeChip';

/**
 * Touch-first job card used on the technician dashboard and mobile job lists.
 * Large tap area, status and priority readable at arm's length.
 */
export const JobCardTile = ({ row }: { readonly row: JobListRow }) => {
  const { job } = row;
  const urgent = job.priority === 'urgent';
  const overdue = isOverdue(job.scheduledDate) && job.status !== 'closed';

  return (
    <Link
      href={`/jobs/${job.jobNumber}`}
      className={cn(
        'group relative block overflow-hidden rounded-[var(--radius-card)] border bg-white p-4 shadow-[var(--shadow-card)] transition-shadow hover:shadow-[var(--shadow-raised)]',
        urgent ? 'border-signal-200' : 'border-steel-200',
      )}
    >
      <span
        className={cn(
          'absolute inset-y-0 left-0 w-1',
          urgent ? 'bg-signal-500' : job.status === 'awaiting_spares' ? 'bg-amber-eje-500' : 'bg-eje-400',
        )}
        aria-hidden="true"
      />

      <div className="flex items-start justify-between gap-3 pl-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-bold text-steel-900">{job.jobNumber}</span>
            <JobTypeChip jobType={job.jobType} size="sm" />
            {urgent && <PriorityBadge priority="urgent" size="sm" />}
          </div>
          <p className="mt-2 truncate text-base font-semibold text-steel-900">
            {row.customerName}
          </p>
          <p className="truncate text-sm text-steel-500">
            {row.siteName} · {row.machineLabel}
          </p>
        </div>
        <JobStatusBadge status={job.status} size="sm" />
      </div>

      {job.faultDescription.length > 0 && (
        <p className="mt-3 line-clamp-2 pl-2 text-sm leading-relaxed text-steel-600">
          {job.faultDescription}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-steel-100 pt-3 pl-2">
        <span
          className={cn(
            'inline-flex items-center gap-1.5 text-xs font-medium',
            overdue ? 'text-signal-600' : isToday(job.scheduledDate) ? 'text-eje-700' : 'text-steel-500',
          )}
        >
          <Icon name={overdue ? 'warning' : 'calendar'} className="size-3.5" />
          {overdue
            ? `Overdue — ${formatDate(job.scheduledDate)}`
            : isToday(job.scheduledDate)
              ? 'Scheduled today'
              : formatDate(job.scheduledDate)}
        </span>

        {row.technicianInitials !== '—' && (
          <span className="inline-flex items-center gap-1.5 text-xs text-steel-500">
            <Avatar initials={row.technicianInitials} size="sm" />
            {row.technicianName}
          </span>
        )}

        <span className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-eje-600 opacity-0 transition-opacity group-hover:opacity-100">
          Open job
          <Icon name="chevronRight" className="size-3.5" />
        </span>
      </div>
    </Link>
  );
};
