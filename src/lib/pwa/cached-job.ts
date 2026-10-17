import type { JobListRow } from '@/application/job-view';

/**
 * WHAT A TABLET IS ALLOWED TO KEEP OF A JOB. PWA-6, CR-09 Phase 3.
 *
 * A deliberately small projection, and smaller than the list row the screen
 * already shows. The question answered here is not "what would be convenient
 * offline" but "what does a technician standing at a machine with no signal
 * actually need to read" — which is: which job, where, what machine, what is
 * wrong with it, and when it is due.
 *
 * WHAT IS LEFT OUT, EACH FOR A REASON:
 *
 *   - `signatureRefusals` — why a customer refused to sign is a dispute in
 *     progress. It belongs on a server a session can be revoked from, not on
 *     a device in a workshop.
 *   - `finalDocument` — a pointer to the customer's signed job card. The
 *     document itself is authorised on every request (IMMUT-6, SEC-1), and a
 *     cached reference to it on a shared tablet is the beginning of a copy.
 *   - Prices, labour, travel and parts — `JobListRow` never carried them and
 *     this carries less.
 *   - Contact names and telephone numbers — personal data about the customer's
 *     staff, and not needed to READ a job.
 *   - Any identifier a client could send back as if it were authority:
 *     `customerId`, `siteId`, `machineId` and the technician ids are dropped.
 *     A cached record is a reminder of what the server said, never an argument
 *     about what the server should do next.
 *
 * NOTHING CACHED HERE IS A PERMISSION. Every action still goes to the server,
 * which decides on the session and not on what the device believes.
 */
export interface CachedJob {
  readonly jobNumber: string;
  readonly status: string;
  readonly jobType: string;
  readonly priority: string;
  readonly scheduledDate: string | null;
  readonly faultDescription: string;
  readonly customerName: string;
  readonly siteName: string;
  readonly machineLabel: string;
  readonly machineSerial: string;
}

/** The whitelist, as data, so a test can hold the shape to it. */
export const CACHED_JOB_FIELDS: readonly (keyof CachedJob)[] = [
  'jobNumber',
  'status',
  'jobType',
  'priority',
  'scheduledDate',
  'faultDescription',
  'customerName',
  'siteName',
  'machineLabel',
  'machineSerial',
];

/**
 * Narrows a list row to what may be kept.
 *
 * Built field by field rather than by deleting from a spread: a spread keeps
 * whatever the server adds to the row next, and the next field somebody adds
 * to `JobSummary` would be cached on every tablet in the field without anybody
 * deciding that it should be.
 */
export const toCachedJob = (row: JobListRow): CachedJob => ({
  jobNumber: row.job.jobNumber,
  status: row.job.status,
  jobType: row.job.jobType,
  priority: row.job.priority,
  scheduledDate: row.job.scheduledDate,
  faultDescription: row.job.faultDescription,
  customerName: row.customerName,
  siteName: row.siteName,
  machineLabel: row.machineLabel,
  machineSerial: row.machineSerial,
});
