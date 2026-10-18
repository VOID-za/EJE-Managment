import {
  isJobOpenWork,
  refusalAwaitingResolution,
  statusMatches,
  priorityRank,
  type JobPriority,
  type UserId,
  type JobStatus,
  type JobTypeCode,
} from '@/domain';
import { isOverdue } from '@/lib/format';
import type { JobListRow } from './job-view';

/**
 * The Jobs list's own filters, in one implementation.
 *
 * WHY THEY MOVED OUT OF THE SCREEN. SEARCH-4 asks for an export of what is on
 * the screen, and "what is on the screen" was a chain of `.filter()` calls
 * inside the Jobs page component. An export built from a second copy of those
 * predicates would agree with the screen on the day it was written and drift
 * from it at the first change, which is the worst kind of export: one that is
 * nearly right. So the predicates live here, the screen calls them, and the
 * export route calls the same ones over the same authorised rows.
 *
 * WHAT THIS MODULE IS NOT. It is not authorisation. Which rows exist for this
 * actor at all is decided by `loadActiveJobList` — DECISION 5 — before any of
 * this runs. These are the user's own choices over what they may already see,
 * and a filter can only ever narrow that set.
 */
export type JobListStatusFilter =
  | JobStatus
  | 'all'
  | 'open-work'
  | 'awaiting_completion'
  | 'overdue';

export interface JobListFilters {
  readonly status: JobListStatusFilter;
  readonly jobType: JobTypeCode | 'all';
  readonly priority: JobPriority | 'all';
  /** Only work this actor is on — their own name, primary or additional. */
  readonly mineOnly: boolean;
  /** The refusal queue, which ignores the status filter entirely. */
  readonly refusalsOnly: boolean;
  readonly term: string;
}

export const emptyJobListFilters: JobListFilters = {
  status: 'open-work',
  jobType: 'all',
  priority: 'all',
  mineOnly: false,
  refusalsOnly: false,
  term: '',
};

export const matchesJobListStatus = (
  status: JobStatus,
  filter: JobListStatusFilter,
  scheduled: string | null,
): boolean => {
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

/** The free-text search, over the fields the screen's own box searches. */
const matchesTerm = (row: JobListRow, needle: string): boolean =>
  needle.length === 0 ||
  row.job.jobNumber.toLowerCase().includes(needle) ||
  row.customerName.toLowerCase().includes(needle) ||
  row.siteName.toLowerCase().includes(needle) ||
  row.machineLabel.toLowerCase().includes(needle) ||
  row.machineSerial.toLowerCase().includes(needle) ||
  row.job.orderNumber.toLowerCase().includes(needle) ||
  row.job.referenceNumber.toLowerCase().includes(needle) ||
  row.job.faultDescription.toLowerCase().includes(needle);

/**
 * The rows the screen shows, in the order it shows them.
 *
 * The sort is part of the answer and not a detail of the table: an export whose
 * rows come back in a different order from the screen that produced it is one
 * nobody can check against what they were looking at.
 */
export const filterJobListRows = (
  rows: readonly JobListRow[],
  filters: JobListFilters,
  actorId: UserId,
): readonly JobListRow[] => {
  const needle = filters.term.trim().toLowerCase();
  return rows
    // Closed and cancelled work is excluded by `loadActiveJobList`.
    .filter((row) => (filters.refusalsOnly ? refusalAwaitingResolution(row.job) : true))
    .filter((row) =>
      // The refusal queue is a queue, not a status: it ignores the status
      // filter entirely rather than intersecting with whatever was selected.
      filters.refusalsOnly
        ? true
        : matchesJobListStatus(row.job.status, filters.status, row.job.scheduledDate),
    )
    .filter((row) => filters.jobType === 'all' || row.job.jobType === filters.jobType)
    .filter((row) => filters.priority === 'all' || row.job.priority === filters.priority)
    .filter(
      (row) =>
        !filters.mineOnly ||
        row.job.primaryTechnicianId === actorId ||
        row.job.additionalTechnicianIds.includes(actorId),
    )
    .filter((row) => matchesTerm(row, needle))
    .sort((a, b) => {
      const rank = priorityRank(a.job.priority) - priorityRank(b.job.priority);
      if (rank !== 0) return rank;
      return (a.job.scheduledDate ?? '9999').localeCompare(b.job.scheduledDate ?? '9999');
    });
};
