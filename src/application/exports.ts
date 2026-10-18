import {
  jobStatusLabel,
  jobTypeLabel,
  priorityLabel,
  type User,
} from '@/domain';
import type { RepositoryBundle } from '@/data/repositories';
import { csvFileName, toCsv, type CsvColumn } from '@/lib/csv';
import { businessToday } from '@/lib/business-time';
import { WorkflowError } from './errors';
import { loadActiveJobList, type JobListRow } from './job-view';
import {
  filterJobListRows,
  type JobListFilters,
} from './job-list-filters';
import {
  loadClosedJobs,
  type ClosedJobFilters,
  type ClosedJobRow,
} from './closed-jobs';

/**
 * Spreadsheet exports of the lists the office works from. MASTER SCOPE SEARCH-4.
 *
 * THE EXPORT IS THE SCREEN'S OWN READ, WRITTEN AS A FILE. Each function below
 * calls the SAME read model the screen calls — `loadActiveJobList` for the Jobs
 * list, `loadClosedJobs` for the archive — and then the same filter
 * implementation the screen applies to it. Nothing here queries a repository
 * directly, and nothing here decides who may read what:
 *
 *   - the Jobs list read applies DECISION 5, so a technician exports the work
 *     they may see and an office role exports the whole operational list;
 *   - `loadClosedJobs` REFUSES a role without `jobs.viewAll` before it reads a
 *     row, so a technician asking for the archive as a file is refused exactly
 *     as they are refused the screen.
 *
 * That is deliberate and it is the whole design: an export that builds its own
 * query is an authorisation decision made twice, and the second one is the one
 * nobody reviews.
 *
 * WHAT IS DELIBERATELY NOT IN THESE FILES, AND WHY.
 *
 * - NO MONEY. `JobListRow` carries a `JobSummary`, which is price-free by
 *   construction, and the archive's own screen shows no figures either. The
 *   archive's read model does carry the issued pricing snapshot — it is there
 *   so a historical job card can be re-rendered at the rates it was issued at —
 *   and it is NOT exported. Putting what each job was charged at into a
 *   spreadsheet is a disclosure the archive screen does not currently make, and
 *   who may have that file is a question for EJE (recorded as an open decision
 *   in the scope register), not one an export button settles.
 * - NO CONTACT DETAILS, NO MEDIA, NO DOCUMENT POINTERS. The archive export says
 *   WHETHER a final job card exists, because its screen shows that; it does not
 *   carry the storage key, which is an internal detail of where the file lives.
 * - NOTHING ABOUT AUTHENTICATION. No session, no token, no password hash and no
 *   email address of a staff member is in any column here.
 *
 * DATES ARE WRITTEN ISO. The screens print "18 Oct 2026", which is right for
 * reading and wrong for a spreadsheet: `YYYY-MM-DD` sorts correctly as text,
 * is unambiguous between conventions, and is what Excel parses as a date
 * without being told the locale.
 */
export interface CsvExport {
  readonly fileName: string;
  /** The whole file, BOM included. */
  readonly csv: string;
  readonly rowCount: number;
}

/**
 * The most rows one export may carry.
 *
 * A LIMIT THAT REFUSES RATHER THAN TRUNCATES. A file that quietly stops at the
 * five-thousandth row is worse than no file: whoever opens it has no way to
 * know it is a fragment, and the office invoices from these. So an export over
 * the limit is refused, with the filters named as the remedy.
 */
export const EXPORT_ROW_LIMIT = 5000;

const tooMany = (matched: number): WorkflowError =>
  new WorkflowError('That export is too large to produce in one file.', [
    {
      code: 'export_too_large',
      message: `${matched} rows matched, and an export carries at most ${EXPORT_ROW_LIMIT}. Narrow the filters — by customer, by type or by date — and export again. Nothing is truncated: a file that silently stopped half way would be worse than this refusal.`,
    },
  ]);

/** A date cell: the ISO date out of a timestamp, or empty where there is none. */
const isoDay = (value: string | null): string => (value === null ? '' : value.slice(0, 10));

const JOB_LIST_COLUMNS: readonly CsvColumn<JobListRow>[] = [
  { header: 'Job number', value: (row) => row.job.jobNumber },
  { header: 'Status', value: (row) => jobStatusLabel(row.job.status) },
  { header: 'Priority', value: (row) => priorityLabel(row.job.priority) },
  { header: 'Job type', value: (row) => jobTypeLabel(row.job.jobType) },
  { header: 'Customer', value: (row) => row.customerName },
  { header: 'Site', value: (row) => row.siteName },
  { header: 'Machine', value: (row) => row.machineLabel },
  { header: 'Serial number', value: (row) => row.machineSerial },
  { header: 'Technician', value: (row) => row.technicianName },
  { header: 'Scheduled', value: (row) => row.job.scheduledDate ?? '' },
  { header: 'Scheduled end', value: (row) => row.job.scheduledEndDate ?? '' },
  { header: 'Order number', value: (row) => row.job.orderNumber },
  { header: 'Reference number', value: (row) => row.job.referenceNumber },
  { header: 'Fault description', value: (row) => row.job.faultDescription },
];

const CLOSED_JOB_COLUMNS: readonly CsvColumn<ClosedJobRow>[] = [
  { header: 'Job number', value: (row) => row.job.jobNumber },
  { header: 'Closed', value: (row) => isoDay(row.job.closedAt) },
  { header: 'Customer', value: (row) => row.customerName },
  { header: 'Site', value: (row) => row.siteName },
  { header: 'Machine', value: (row) => row.machineLabel },
  { header: 'Serial number', value: (row) => row.machineSerial },
  { header: 'Job type', value: (row) => jobTypeLabel(row.job.jobType) },
  { header: 'Technician', value: (row) => row.technicianName },
  { header: 'Order number', value: (row) => row.job.orderNumber },
  { header: 'Reference number', value: (row) => row.job.referenceNumber },
  /*
   * WHETHER the document exists, which is what the screen's icon says. Not
   * where it is: the storage key is internal and is no business of a
   * spreadsheet.
   */
  { header: 'Final job card', value: (row) => (row.job.finalDocument === null ? 'No' : 'Yes') },
];

/** The column headers, exported so a test can pin them without a file. */
export const jobListExportColumns = JOB_LIST_COLUMNS.map((column) => column.header);
export const closedJobsExportColumns = CLOSED_JOB_COLUMNS.map((column) => column.header);

/**
 * The operational Jobs list, as this actor may read it, filtered as they asked.
 */
export const exportJobList = async (
  repos: RepositoryBundle,
  actor: Pick<User, 'id' | 'role'>,
  filters: JobListFilters,
): Promise<CsvExport> => {
  const rows = filterJobListRows(await loadActiveJobList(repos, actor), filters, actor.id);
  if (rows.length > EXPORT_ROW_LIMIT) throw tooMany(rows.length);
  return {
    fileName: csvFileName('eje-jobs', businessToday()),
    csv: toCsv(JOB_LIST_COLUMNS, rows),
    rowCount: rows.length,
  };
};

/**
 * The closed-job archive, with the archive screen's own filters.
 *
 * `loadClosedJobs` is asked for one row more than the limit, so "too large" is
 * decided on what actually matched rather than on a count taken separately from
 * the rows — two reads of a moving archive can disagree.
 */
export const exportClosedJobs = async (
  repos: RepositoryBundle,
  actor: Pick<User, 'id' | 'role'>,
  filters: ClosedJobFilters,
): Promise<CsvExport> => {
  const page = await loadClosedJobs(repos, actor, filters, EXPORT_ROW_LIMIT + 1);
  if (page.rows.length > EXPORT_ROW_LIMIT) throw tooMany(page.matched);
  return {
    fileName: csvFileName('eje-closed-jobs', businessToday()),
    csv: toCsv(CLOSED_JOB_COLUMNS, page.rows),
    rowCount: page.rows.length,
  };
};
