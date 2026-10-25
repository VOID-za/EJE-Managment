import type { JobId, MachineId, UserId } from '../types/common';
import type { Job } from '../types/job';
import type { User } from '../types/user';
import { can } from '../access';

/**
 * Which jobs a person may see, and how much of one.
 *
 * The office sees everything; a technician sees their own work, the pool they
 * take work from, and the history of the machines they have worked on. Another
 * technician's LIVE job is not theirs to read, and knowing the job number does
 * not change that.
 *
 * This is a PREDICATE, deliberately. It is written so a repository can turn it
 * into a WHERE clause rather than a filter applied after everything has already
 * been loaded — which is the difference between a rule and a curtain.
 *
 * The historical half of the rule cannot be answered from the job alone: a
 * technician who captured half a job on Tuesday and had it reassigned on
 * Wednesday is no longer on it, and `primaryTechnicianId` has forgotten they
 * ever were. That is what participation history is for, and why the caller
 * supplies it.
 */

/** What a viewer's history with the business says they have touched. */
export interface TechnicianHistory {
  /** Every job this person has ever been on, whether or not they still are. */
  readonly participatedJobIds: ReadonlySet<string>;
  /** Every machine they have worked on, from those jobs. */
  readonly workedMachineIds: ReadonlySet<string>;
}

export const emptyTechnicianHistory: TechnicianHistory = {
  participatedJobIds: new Set<string>(),
  workedMachineIds: new Set<string>(),
};

/** Builds the history sets from the jobs a person has participated in. */
export const technicianHistoryFrom = (
  participated: readonly Pick<Job, 'id' | 'machineId'>[],
): TechnicianHistory => ({
  participatedJobIds: new Set(participated.map((job) => job.id as string)),
  workedMachineIds: new Set(
    participated
      .map((job) => job.machineId)
      .filter((id): id is MachineId => id !== null)
      .map((id) => id as string),
  ),
});

/** A job that has finished, one way or the other. */
const isHistorical = (job: Pick<Job, 'status'>): boolean =>
  job.status === 'closed' || job.status === 'invoiced' || job.status === 'cancelled';

/**
 * Why this viewer may see this job. Null when they may not.
 *
 * The REASON is returned rather than a boolean because the read layer needs it:
 * a job reached through machine history is read-only and has its prices
 * suppressed, and a job reached because it is yours is not.
 */
export type JobVisibility =
  /** The office. Everything, in full. */
  | 'office'
  /** Unassigned work in the pool, which is what a technician accepts from. */
  | 'open_pool'
  /** Currently theirs: primary or additional. */
  | 'assigned'
  /** They were on it once. Their own work, so they keep access to it. */
  | 'participated'
  /** Finished work on a machine they have worked. Read-only, prices withheld. */
  | 'machine_history';

/**
 * A DRAFT IS INVISIBLE TO ANYBODY WHO MAY NOT MANAGE ONE. DRAFT-1.
 *
 * Checked before everything else, including `jobs.viewAll` and including being
 * NAMED on the job, and that order is the whole rule. A draft is not yet a job
 * the business is working on: a Coordinator seeing one on the Jobs screen would
 * be seeing work that may never be raised, and a technician named on one as an
 * intention would be seeing an assignment nobody has made.
 */
export const canSeeDraftJobs = (role: User['role']): boolean => can(role, 'jobs.manageDrafts');

/**
 * Drops drafts a viewer may not see, for a read that short-circuits on
 * `jobs.viewAll` and therefore never reaches `jobVisibilityFor`.
 *
 * It exists because those short-circuits are a PERFORMANCE decision — the
 * office may read everything, so why ask per row — and DRAFT-1 is the first
 * rule where "the office" is not one thing. Applied in the four list reads
 * rather than inside each screen, so a new screen inherits it.
 */
export const withoutHiddenDrafts = <T extends Pick<Job, 'status'>>(
  viewer: Pick<User, 'role'>,
  jobs: readonly T[],
): readonly T[] =>
  canSeeDraftJobs(viewer.role) ? jobs : jobs.filter((job) => job.status !== 'draft');

export const jobVisibilityFor = (
  viewer: Pick<User, 'id' | 'role'>,
  job: Pick<Job, 'id' | 'status' | 'primaryTechnicianId' | 'additionalTechnicianIds' | 'machineId'>,
  history: TechnicianHistory,
): JobVisibility | null => {
  // DRAFT-1, and FIRST: see `canSeeDraftJobs` for why the order is the rule.
  if (job.status === 'draft') return canSeeDraftJobs(viewer.role) ? 'office' : null;

  if (can(viewer.role, 'jobs.viewAll')) return 'office';

  if (job.primaryTechnicianId === viewer.id) return 'assigned';
  if (job.additionalTechnicianIds.includes(viewer.id as UserId)) return 'assigned';
  if (history.participatedJobIds.has(job.id as string)) return 'participated';

  // The pool: unassigned work anybody may take. It is how a technician gets a
  // job in the first place, so it cannot be gated on already having it.
  if (job.status === 'open' && job.primaryTechnicianId === null) return 'open_pool';

  /*
   * The machine's history.
   *
   * The most useful thing a technician can read before a call-out is what was
   * last done to the machine they are driving to. Finished work only, and the
   * prices are withheld — what EJE charged another customer's job is not part
   * of knowing what went wrong with the spindle.
   */
  if (
    isHistorical(job) &&
    job.machineId !== null &&
    history.workedMachineIds.has(job.machineId as string)
  ) {
    return 'machine_history';
  }

  return null;
};

export const canSeeJob = (
  viewer: Pick<User, 'id' | 'role'>,
  job: Pick<Job, 'id' | 'status' | 'primaryTechnicianId' | 'additionalTechnicianIds' | 'machineId'>,
  history: TechnicianHistory,
): boolean => jobVisibilityFor(viewer, job, history) !== null;

/** Whether this viewer may see what the job cost, at this level of access. */
export const showsPricesAt = (visibility: JobVisibility): boolean =>
  visibility !== 'machine_history';

/** Whether this viewer may change anything on the job, at this level of access. */
export const isReadOnlyAt = (visibility: JobVisibility): boolean =>
  visibility === 'machine_history' || visibility === 'participated';

/**
 * The job with the commercial figures removed.
 *
 * Suppression by REMOVAL, not by hiding: a job handed to a technician through
 * machine history has no prices on it at all, so no screen, no export and no
 * hand-typed URL can render what is not there. The same discipline as
 * `redactRefusalsForViewer`.
 *
 * Quantities and part numbers stay — a technician needs to know two encoders
 * were fitted. What they lose is what anybody paid.
 */
export const withoutPrices = <T extends Job>(job: T): T => ({
  ...job,
  parts: job.parts.map((part) => ({ ...part, unitPrice: 0 })),
  pricingSnapshot: null,
  calloutApplied: false,
});

/**
 * The jobs this viewer may see, with prices suppressed where the rule says so.
 *
 * One function, so a caller cannot apply the visibility rule and forget the
 * price rule that travels with it.
 */
export const visibleJobsFor = <T extends Job>(
  viewer: Pick<User, 'id' | 'role'>,
  jobs: readonly T[],
  history: TechnicianHistory,
): readonly T[] => {
  const visible: T[] = [];
  for (const job of jobs) {
    const visibility = jobVisibilityFor(viewer, job, history);
    if (visibility === null) continue;
    visible.push(showsPricesAt(visibility) ? job : withoutPrices(job));
  }
  return visible;
};

/** The job ids a technician has ever been on, for a repository to resolve. */
export const participantJobIds = (history: TechnicianHistory): readonly JobId[] =>
  [...history.participatedJobIds] as JobId[];

/* -------------------------------------------------------------------------- */
/* Summaries                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A job as a LIST row needs it, and no more.
 *
 * WHY THIS TYPE EXISTS. Rendering the Jobs screen was hydrating complete job
 * aggregates — parts, labour, travel, media, notes, signatures, refusals,
 * pricing snapshots, final documents, delivery attempts and checklists, twelve
 * unbounded child reads — to display a job number, a customer and a status. At
 * twenty-four jobs that is merely wasteful; at five thousand it returns every
 * photograph and every labour line in the business to draw a table.
 *
 * It is a `Pick` of `Job` ON PURPOSE, so that every existing `Job` already IS a
 * valid summary. Callers that legitimately hold a full job — the demonstration
 * store, the tests, a detail screen — keep working untouched, and only the
 * PostgreSQL list path produces a genuinely narrow row.
 *
 * WHAT IS NOT HERE IS THE POINT. A summary carries no parts, no pricing
 * snapshot and no callout flag, so there is no price in it to suppress. That is
 * a stronger guarantee than `withoutPrices` can give: a value that was never
 * selected cannot leak. `summariesVisibleTo` below states it and
 * `visibility.test.ts` proves it.
 */
export type JobSummary = Pick<
  Job,
  | 'id'
  | 'jobNumber'
  | 'status'
  | 'jobType'
  | 'priority'
  | 'scheduledDate'
  | 'closedAt'
  | 'submittedAt'
  | 'referenceNumber'
  | 'orderNumber'
  | 'faultDescription'
  /*
   * THE TEST & REPAIR FIELDS. TR-1.
   *
   * Columns on `jobs`, like the order number beside them, and the archive
   * export reconciles the work with them — a spreadsheet of closed jobs that
   * cannot say which unit was booked in is no use for the job type it
   * describes. They are not what this type withholds: a summary carries no
   * parts, no pricing snapshot and no callout flag, and a part NUMBER is not a
   * price (`withoutPrices` keeps part numbers and quantities deliberately).
   */
  | 'quoteNumber'
  | 'dateReceived'
  | 'repairItem'
  // The office lifecycle (issue #73): the Notifications tabs and the archive
  // list jobs by these, and neither is a price.
  | 'officeHandling'
  | 'invoice'
  | 'customerId'
  | 'siteId'
  | 'machineId'
  | 'primaryTechnicianId'
  | 'additionalTechnicianIds'
  /** Sorts the job history on a customer and on a machine. */
  | 'createdAt'
  /** The technician dashboard groups by what was finished. */
  | 'completedAt'
  /** The list shows a scheduled range, not a single date. */
  | 'scheduledEndDate'
  /** The refusal badge and the refusal queue. REDACTED PER VIEWER — see below. */
  | 'signatureRefusals'
  /** The closed-job archive shows whether the issued document exists. */
  | 'finalDocument'
>;

/**
 * The summaries this viewer may see.
 *
 * The visibility half of Decision 5, unchanged — `jobVisibilityFor` already
 * asked only for `id`, `status`, `primaryTechnicianId`,
 * `additionalTechnicianIds` and `machineId`, every one of which a summary
 * carries. The price half needs nothing done, because a summary has no price
 * on it; `visibleJobsFor` remains the function to use whenever a caller really
 * is holding full jobs.
 */
export const summariesVisibleTo = <T extends JobSummary>(
  viewer: Pick<User, 'id' | 'role'>,
  jobs: readonly T[],
  history: TechnicianHistory,
): readonly T[] => jobs.filter((job) => jobVisibilityFor(viewer, job, history) !== null);

/**
 * Narrows anything job-shaped to a summary, dropping everything else.
 *
 * Callers that legitimately hold full jobs — a customer's job history, a
 * machine's — still build list rows, and a `Job` structurally satisfies
 * `JobSummary`, so handing one straight through would compile and would ship
 * the parts, the pricing snapshot and the refusals to the browser inside a row
 * that displays none of them. This makes the narrowing real at runtime, not
 * only in the type, which is what makes `redactRefusalsForViewer` unnecessary
 * on a list: there is no refusal left in the row to redact.
 */
export const toJobSummary = (job: JobSummary): JobSummary => ({
  id: job.id,
  jobNumber: job.jobNumber,
  status: job.status,
  jobType: job.jobType,
  priority: job.priority,
  scheduledDate: job.scheduledDate,
  closedAt: job.closedAt,
  submittedAt: job.submittedAt,
  referenceNumber: job.referenceNumber,
  orderNumber: job.orderNumber,
  faultDescription: job.faultDescription,
  quoteNumber: job.quoteNumber,
  dateReceived: job.dateReceived,
  repairItem: job.repairItem,
  officeHandling: job.officeHandling,
  invoice: job.invoice,
  customerId: job.customerId,
  siteId: job.siteId,
  machineId: job.machineId,
  primaryTechnicianId: job.primaryTechnicianId,
  additionalTechnicianIds: job.additionalTechnicianIds,
  createdAt: job.createdAt,
  completedAt: job.completedAt,
  scheduledEndDate: job.scheduledEndDate,
  signatureRefusals: job.signatureRefusals,
  finalDocument: job.finalDocument,
});
