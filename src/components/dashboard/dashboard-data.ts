import type { Job, JobPriority, User } from '@/domain';
import {
  isJobOpenWork,
  PRIORITY_ORDER,
  priorityLabel,
  refusalAwaitingResolution,
} from '@/domain';
import type { JobListRow } from '@/application/job-view';
import { isOverdue, isToday } from '@/lib/format';

/**
 * Dashboard selectors.
 *
 * Pure functions over the loaded job rows. Keeping them out of the components
 * means the same numbers can be asserted in tests and later computed by the API
 * without changing what the dashboard renders.
 */

export const byStatus = (rows: readonly JobListRow[], statuses: readonly Job['status'][]) =>
  rows.filter((row) => statuses.includes(row.job.status));

export const openJobs = (rows: readonly JobListRow[]) =>
  rows.filter((row) => isJobOpenWork(row.job.status));

/**
 * Jobs a customer refused to sign, that nobody has dealt with yet.
 *
 * Dynamic by construction: it reads the refusals on the job, so correcting and
 * resubmitting a job card takes it out of this list and a second refusal puts
 * it back. Nothing has to be ticked off anywhere.
 *
 * It counts what the VIEWER can see: the rows are redacted per person before
 * they get here, so a technician's own numbers are their own jobs and the
 * office's are everybody's. See `loadJobRows`.
 */
export const unresolvedRefusals = (rows: readonly JobListRow[]) =>
  rows.filter((row) => refusalAwaitingResolution(row.job));

export const overdueJobs = (rows: readonly JobListRow[]) =>
  rows.filter((row) => isJobOpenWork(row.job.status) && isOverdue(row.job.scheduledDate));

export const todaysJobs = (rows: readonly JobListRow[]) =>
  rows.filter((row) => isJobOpenWork(row.job.status) && isToday(row.job.scheduledDate));

export const upcomingJobs = (rows: readonly JobListRow[], limit = 6) =>
  rows
    .filter(
      (row) =>
        isJobOpenWork(row.job.status) &&
        row.job.scheduledDate !== null &&
        !isOverdue(row.job.scheduledDate) &&
        !isToday(row.job.scheduledDate),
    )
    .sort((a, b) => (a.job.scheduledDate ?? '').localeCompare(b.job.scheduledDate ?? ''))
    .slice(0, limit);

export const recentlySubmitted = (rows: readonly JobListRow[], limit = 5) =>
  rows
    .filter((row) => row.job.submittedAt !== null)
    .sort((a, b) => (b.job.submittedAt ?? '').localeCompare(a.job.submittedAt ?? ''))
    .slice(0, limit);

export const recentlyClosed = (rows: readonly JobListRow[], limit = 5) =>
  rows
    .filter((row) => row.job.closedAt !== null)
    .sort((a, b) => (b.job.closedAt ?? '').localeCompare(a.job.closedAt ?? ''))
    .slice(0, limit);

export interface TechnicianLoad {
  readonly technician: User;
  readonly active: number;
  readonly inProgress: number;
  readonly awaitingSpares: number;
}

export const jobsByTechnician = (
  rows: readonly JobListRow[],
  users: readonly User[],
): readonly TechnicianLoad[] =>
  users
    .filter((user) => user.role === 'technician' && user.active)
    .map((technician) => {
      const assigned = rows.filter(
        (row) =>
          isJobOpenWork(row.job.status) &&
          (row.job.primaryTechnicianId === technician.id ||
            row.job.additionalTechnicianIds.includes(technician.id)),
      );
      return {
        technician,
        active: assigned.length,
        inProgress: assigned.filter((row) => row.job.status === 'in_progress').length,
        awaitingSpares: assigned.filter((row) => row.job.status === 'awaiting_spares').length,
      };
    })
    .sort((a, b) => b.active - a.active);

export interface PriorityCount {
  readonly priority: JobPriority;
  readonly label: string;
  readonly count: number;
}

export const jobsByPriority = (rows: readonly JobListRow[]): readonly PriorityCount[] => {
  const active = openJobs(rows);
  return PRIORITY_ORDER.map((priority) => ({
    priority,
    label: priorityLabel(priority),
    count: active.filter((row) => row.job.priority === priority).length,
  }));
};
