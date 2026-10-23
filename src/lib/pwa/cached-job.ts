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
  /** Null where nobody has graded the job. Create New Job §3B. */
  readonly priority: string | null;
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
  // Null where nobody has graded the job. The cached list shows it ungraded
  // rather than guessing a grade the tablet was never given.
  priority: row.job.priority,
  scheduledDate: row.job.scheduledDate,
  faultDescription: row.job.faultDescription,
  customerName: row.customerName,
  siteName: row.siteName,
  machineLabel: row.machineLabel,
  machineSerial: row.machineSerial,
});

/**
 * WHAT A TABLET MAY KEEP OF ONE JOB'S DETAIL. OFF-DETAIL-1, OFF-1.
 *
 * The list projection above answers "which job, where, what machine". This
 * answers the next question, which is the one a technician in a basement
 * actually has: *what has been captured on this job so far?* Before it, a
 * tablet with no signal could show the list and nothing else — so a technician
 * who had the job open, lost coverage and had the application reload could not
 * see the hours they had already recorded, or which checklist questions were
 * answered, and had no way to tell what was left to do.
 *
 * IT IS A COPY, AND IT IS SAID TO BE ONE. Every screen that renders it shows
 * when it arrived, nothing on it may be edited, and the actions all stay with
 * the server. The authority is the server's answer, not this.
 *
 * WHAT IS LEFT OUT, EACH FOR A REASON — and the list is longer than what is
 * kept, deliberately:
 *
 *   - PRICES, of every kind: unit prices, the pricing snapshot, the call-out
 *     fee, any total. A technician needs to know two encoders were fitted, not
 *     what the customer is paying for them, and a cached commercial figure on
 *     a device that changes hands between shifts is the beginning of a leak
 *     this feature has no need to risk. (The same instinct as `withoutPrices`
 *     in the domain.)
 *   - THE SIGNATURE and its stroke data, and every signature REFUSAL. The most
 *     consequential records in the system, on a server a session can be
 *     revoked from (OFF-5, SEC-1).
 *   - THE FINAL DOCUMENT and any pointer to it. Authorised on every request
 *     (IMMUT-6); a cached reference is the beginning of a copy.
 *   - CONTACT NAMES, TELEPHONE NUMBERS AND EMAIL ADDRESSES. Personal data
 *     about the customer's staff, and not needed to read what was done.
 *   - EVERY IDENTIFIER the client could send back as authority: no job id, no
 *     customer, site or machine id, no user ids, no attachment ids. A cached
 *     record is a reminder of what the server said, never an argument about
 *     what it should do next.
 *   - THE PHOTOGRAPHS themselves. Captions only: the bytes are megabytes, they
 *     are authorised per request, and the ones this tablet is HOLDING are a
 *     different thing entirely (`pending-media.ts`).
 */
export interface CachedJobDetail extends CachedJob {
  /** `<userId>:<jobNumber>`. The user is part of the key, not a column. */
  readonly key: string;
  readonly userId: string;
  /** When the server said this. Rendered wherever the copy is shown. */
  readonly capturedAt: string;
  readonly siteAddress: string;
  readonly orderNumber: string;
  readonly referenceNumber: string;
  /** What was found and done, as the technician typed it. No prices anywhere. */
  readonly workPerformed: string;
  readonly faultFindings: string;
  readonly diagnosis: string;
  readonly recommendations: string;
  readonly labour: readonly { readonly date: string; readonly hours: number; readonly rateType: string; readonly description: string }[];
  readonly travel: readonly { readonly date: string; readonly kilometres: number; readonly description: string }[];
  readonly parts: readonly { readonly partNumber: string; readonly description: string; readonly quantity: number }[];
  readonly notes: readonly { readonly body: string; readonly internal: boolean; readonly createdAt: string }[];
  readonly photoCaptions: readonly string[];
  /** The checklist, as far as it has got. Null where the job has none. */
  readonly checklist:
    | {
        readonly name: string;
        readonly templateVersion: string;
        readonly answered: number;
        readonly total: number;
        readonly completed: boolean;
        readonly outstanding: readonly string[];
      }
    | null;
}

export interface JobDetailSource {
  readonly job: {
    readonly jobNumber: string;
    readonly status: string;
    readonly jobType: string;
    readonly priority: string | null;
    readonly scheduledDate: string | null;
    readonly faultDescription: string;
    readonly orderNumber: string;
    readonly referenceNumber: string;
    readonly completionReport: {
      readonly workPerformed: string;
      readonly faultFindings: string;
      readonly diagnosis: string;
      readonly recommendations: string;
    };
    readonly labour: readonly {
      readonly date: string;
      readonly hours: number;
      readonly rateType: string;
      readonly description: string;
    }[];
    readonly travel: readonly {
      readonly date: string;
      readonly kilometres: number;
      readonly description: string;
    }[];
    readonly parts: readonly {
      readonly partNumber: string;
      readonly description: string;
      readonly quantity: number;
    }[];
    readonly notes: readonly {
      readonly body: string;
      readonly internal: boolean;
      readonly createdAt: string;
    }[];
    readonly photos: readonly { readonly caption: string; readonly fileName: string }[];
  };
  readonly customerName: string;
  readonly siteName: string;
  readonly siteAddress: string;
  readonly machineLabel: string;
  readonly machineSerial: string;
  readonly checklist: CachedJobDetail['checklist'];
}

/**
 * Narrows one job view to what may be kept on the device.
 *
 * Field by field, like `toCachedJob` and for the same reason: a spread would
 * cache whatever is added to the job next, on every tablet in the field,
 * without anybody deciding that it should be.
 */
export const toCachedJobDetail = (
  userId: string,
  source: JobDetailSource,
  capturedAt: string,
): CachedJobDetail => ({
  key: `${userId}:${source.job.jobNumber}`,
  userId,
  capturedAt,
  jobNumber: source.job.jobNumber,
  status: source.job.status,
  jobType: source.job.jobType,
  priority: source.job.priority,
  scheduledDate: source.job.scheduledDate,
  faultDescription: source.job.faultDescription,
  customerName: source.customerName,
  siteName: source.siteName,
  machineLabel: source.machineLabel,
  machineSerial: source.machineSerial,
  siteAddress: source.siteAddress,
  orderNumber: source.job.orderNumber,
  referenceNumber: source.job.referenceNumber,
  workPerformed: source.job.completionReport.workPerformed,
  faultFindings: source.job.completionReport.faultFindings,
  diagnosis: source.job.completionReport.diagnosis,
  recommendations: source.job.completionReport.recommendations,
  labour: source.job.labour.map((line) => ({
    date: line.date,
    hours: line.hours,
    rateType: line.rateType,
    description: line.description,
  })),
  travel: source.job.travel.map((line) => ({
    date: line.date,
    kilometres: line.kilometres,
    description: line.description,
  })),
  parts: source.job.parts.map((line) => ({
    partNumber: line.partNumber,
    description: line.description,
    quantity: line.quantity,
  })),
  notes: source.job.notes.map((note) => ({
    body: note.body,
    internal: note.internal,
    createdAt: note.createdAt,
  })),
  photoCaptions: source.job.photos.map((photo) =>
    photo.caption.length > 0 ? photo.caption : photo.fileName,
  ),
  checklist: source.checklist,
});
