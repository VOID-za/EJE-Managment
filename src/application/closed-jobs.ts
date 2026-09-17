import { userFullName, type IsoDate, type Job, type JobTypeCode, type User } from '@/domain';
import type { RepositoryBundle } from '@/data/repositories';
import { loadJobRows, type JobListRow } from './job-view';

/**
 * The closed-job archive.
 *
 * Closed jobs are historical business records: the office has to be able to
 * find one years later from whatever they remember — a job number, a customer,
 * a serial number on a machine, a purchase order. So the search is deliberately
 * across all of those rather than the job number alone.
 *
 * Reads and filtering happen here, not in the screen, so the same query can be
 * served by one API call in Phase 2 without the page changing. The demo
 * repository is unpaginated, so the result is capped and the caller is told how
 * many matched — a screen that assumed a handful of records would quietly
 * mislead once EJE has years of history.
 */
export interface ClosedJobFilters {
  /** Free text across job number, customer, site, machine, serial, order, ref. */
  readonly term: string;
  readonly customerId: string | 'all';
  readonly siteId: string | 'all';
  readonly jobType: JobTypeCode | 'all';
  readonly technicianId: string | 'all';
  /** Inclusive, against the date the job was closed. */
  readonly closedFrom: IsoDate | '';
  readonly closedTo: IsoDate | '';
}

export const emptyClosedJobFilters: ClosedJobFilters = {
  term: '',
  customerId: 'all',
  siteId: 'all',
  jobType: 'all',
  technicianId: 'all',
  closedFrom: '',
  closedTo: '',
};

export interface ClosedJobsPage {
  readonly rows: readonly JobListRow[];
  /** How many matched the filters in total, before the cap. */
  readonly matched: number;
  /** True when `rows` is a capped slice of `matched`. */
  readonly truncated: boolean;
  readonly customers: readonly { readonly id: string; readonly name: string }[];
  readonly sites: readonly { readonly id: string; readonly name: string; readonly customerId: string }[];
  readonly technicians: readonly User[];
}

/** Matched rows returned in one page. Enough to work with, not a whole archive. */
export const CLOSED_JOBS_PAGE_SIZE = 50;

const matchesTerm = (row: JobListRow, needle: string): boolean => {
  if (needle.length === 0) return true;
  const haystack = [
    row.job.jobNumber,
    row.customerName,
    row.siteName,
    row.machineLabel,
    row.machineSerial,
    row.job.orderNumber,
    row.job.referenceNumber,
    row.technicianName,
  ];
  return haystack.some((value) => value.toLowerCase().includes(needle));
};

const closedOn = (job: Job): IsoDate | null =>
  job.closedAt === null ? null : job.closedAt.slice(0, 10);

/**
 * Whether a job belongs in the archive.
 *
 * Only genuinely closed work: cancelled jobs never happened, and a job still in
 * Master Review has not been issued. Soft-deleted jobs are excluded by the
 * repository itself.
 */
export const isArchivedJob = (job: Job): boolean =>
  job.status === 'closed' && job.deletedAt === null;

export const loadClosedJobs = async (
  repos: RepositoryBundle,
  filters: ClosedJobFilters,
  pageSize: number = CLOSED_JOBS_PAGE_SIZE,
): Promise<ClosedJobsPage> => {
  const [jobs, customers, sites, users] = await Promise.all([
    repos.jobs.list({ statuses: ['closed'] }),
    repos.customers.list(),
    repos.customers.listSites(),
    repos.users.list(),
  ]);

  const archived = jobs.filter(isArchivedJob);
  const allRows = await loadJobRows(repos, archived);
  const needle = filters.term.trim().toLowerCase();

  const matchedRows = allRows
    .filter((row) => matchesTerm(row, needle))
    .filter((row) => filters.customerId === 'all' || row.job.customerId === filters.customerId)
    .filter((row) => filters.siteId === 'all' || row.job.siteId === filters.siteId)
    .filter((row) => filters.jobType === 'all' || row.job.jobType === filters.jobType)
    .filter(
      (row) =>
        filters.technicianId === 'all' ||
        row.job.primaryTechnicianId === filters.technicianId ||
        row.job.additionalTechnicianIds.includes(filters.technicianId as never),
    )
    .filter((row) => {
      const date = closedOn(row.job);
      if (filters.closedFrom.length > 0 && (date === null || date < filters.closedFrom)) {
        return false;
      }
      if (filters.closedTo.length > 0 && (date === null || date > filters.closedTo)) return false;
      return true;
    })
    // Most recently closed first: the archive is usually searched from the
    // recent end.
    .sort((a, b) => (b.job.closedAt ?? '').localeCompare(a.job.closedAt ?? ''));

  return {
    rows: matchedRows.slice(0, pageSize),
    matched: matchedRows.length,
    truncated: matchedRows.length > pageSize,
    customers: [...customers]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((customer) => ({ id: customer.id, name: customer.name })),
    sites: [...sites]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((site) => ({ id: site.id, name: site.name, customerId: site.customerId })),
    technicians: users
      .filter((user) => user.role === 'technician')
      .sort((a, b) => userFullName(a).localeCompare(userFullName(b))),
  };
};
