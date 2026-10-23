import {
  can,
  jobStatusLabel,
  jobTypeLabel,
  priorityLabelOrUngraded,
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
  /**
   * The headers this file actually carries. BD-17, BD-18.
   *
   * Reported rather than assumed, because the closed-job export's columns now
   * depend on the ACTOR — and the export-audit record names the columns that
   * were taken, which must be the ones in the file rather than a constant that
   * could drift from it.
   */
  readonly columns: readonly string[];
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
  // "Not graded" rather than an empty cell: a blank under this header
  // reads as data loss rather than as a job nobody has graded.
  { header: 'Priority', value: (row) => priorityLabelOrUngraded(row.job.priority) },
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
  /*
   * THE TEST & REPAIR FIELDS ARE ON THE CLOSED-JOB EXPORT AND NOT THIS ONE.
   * TR-1.
   *
   * Not an oversight. This export runs off `JobSummary`, which exists
   * precisely so the operational list is not an aggregate read of every job in
   * the business — and pulling four fields that only one job type captures
   * into every summary would undo that for the sake of four mostly-empty
   * columns. The unit booked in is on the job's own screen, on its job card,
   * and on the ARCHIVE export below, which is where the office reconciles the
   * work after it is done.
   */
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
   * THE TEST & REPAIR FIELDS. TR-1, and "relevant exports" is why they are
   * here.
   *
   * Empty on every job type that does not capture them, exactly as Order
   * number and Reference number already are — a spreadsheet of jobs that
   * cannot say WHICH UNIT was booked in is no use for reconciling the work it
   * describes. These are REFERENCES AND QUANTITIES, not money: `withoutPrices`
   * strips what anybody paid and deliberately keeps part numbers and
   * quantities, because a technician needs to know two encoders were fitted.
   * So a technician's own export carries these and still carries no prices.
   */
  { header: 'Quote number', value: (row) => row.job.quoteNumber },
  { header: 'Part number', value: (row) => row.job.repairItem.partNumber },
  { header: 'Part description', value: (row) => row.job.repairItem.description },
  {
    header: 'Quantity',
    // Empty rather than 0: nobody recorded a quantity, which is not the same
    // as recording none of them.
    value: (row) =>
      row.job.repairItem.quantity === null ? '' : String(row.job.repairItem.quantity),
  },
  /*
   * WHETHER the document exists, which is what the screen's icon says. Not
   * where it is: the storage key is internal and is no business of a
   * spreadsheet.
   */
  { header: 'Final job card', value: (row) => (row.job.finalDocument === null ? 'No' : 'Yes') },
];

/**
 * WHAT EVERY CLOSED JOB WAS CHARGED AT. BD-17, and nobody may export it today.
 *
 * The archive's read model carries each job's ISSUED pricing snapshot — it is
 * there so a historical job card re-renders at its own rates — and these are
 * the columns that would put it in a spreadsheet. They are built, ordered and
 * tested, and they are appended only for an actor holding
 * `jobs.exportPrices`, WHICH NO ROLE HOLDS.
 *
 * That is not a half-finished feature: it is BD-17's two questions separated
 * from each other. "May the prices be exported at all" is answered by whether
 * these columns exist; "by whom" is answered by granting the capability to a
 * role. The first is now a decision EJE can see the shape of, and the second
 * is one line in `access.ts`.
 *
 * PRICED FROM THE SNAPSHOT AND NOTHING ELSE. A closed job that carries none —
 * one issued before snapshots existed, or closed without a signature — exports
 * EMPTY CELLS rather than today's rates applied to old work, which would be a
 * spreadsheet of figures EJE never charged.
 */
const CLOSED_JOB_PRICE_COLUMNS: readonly CsvColumn<ClosedJobRow>[] = [
  {
    header: 'Subtotal (excl. VAT)',
    value: (row) => centsOrEmpty(row.issuedTotals?.subtotal),
  },
  { header: 'VAT', value: (row) => centsOrEmpty(row.issuedTotals?.vat) },
  { header: 'Total (incl. VAT)', value: (row) => centsOrEmpty(row.issuedTotals?.total) },
  {
    header: 'Priced at',
    /*
     * WHEN the rates were frozen, beside the figures. A total with no date is
     * a figure somebody will compare against this year's rates and query.
     */
    value: (row) => isoDay(row.issuedTotals?.capturedAt ?? null),
  },
];

/**
 * Cents as a plain decimal, or EMPTY for a job that carries no snapshot.
 *
 * Not "0.00", which would say the job was done for nothing. A spreadsheet cell
 * that is empty is a cell a person asks about; a zero is one they believe.
 */
const centsOrEmpty = (cents: number | undefined): string =>
  cents === undefined ? '' : (cents / 100).toFixed(2);

/**
 * The columns this actor's closed-job export carries. BD-17.
 *
 * One function, so the HEADERS a test pins and the ROWS a file carries cannot
 * disagree about who sees the money.
 */
export const closedJobColumnsFor = (
  actor: Pick<User, 'role'>,
): readonly CsvColumn<ClosedJobRow>[] =>
  can(actor.role, 'jobs.exportPrices')
    ? [...CLOSED_JOB_COLUMNS, ...CLOSED_JOB_PRICE_COLUMNS]
    : CLOSED_JOB_COLUMNS;

/** The column headers, exported so a test can pin them without a file. */
export const jobListExportColumns = JOB_LIST_COLUMNS.map((column) => column.header);
export const closedJobsExportColumns = CLOSED_JOB_COLUMNS.map((column) => column.header);
/** The four BD-17 columns, by name, for a test that must not guess them. */
export const closedJobPriceColumns = CLOSED_JOB_PRICE_COLUMNS.map((column) => column.header);

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
    columns: jobListExportColumns,
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
  /*
   * THE COLUMNS DEPEND ON THE ACTOR. BD-17: the money is appended only for
   * somebody holding `jobs.exportPrices`, which no role holds today — so every
   * file EJE can produce right now carries none, which is the current
   * behaviour and not the answer.
   */
  const columns = closedJobColumnsFor(actor);
  return {
    fileName: csvFileName('eje-closed-jobs', businessToday()),
    csv: toCsv(columns, page.rows),
    rowCount: page.rows.length,
    columns: columns.map((column) => column.header),
  };
};
