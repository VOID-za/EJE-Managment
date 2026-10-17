import type { JobCompletionReport } from '@/domain';

/**
 * A COMPLETION WRITE-UP TYPED WITH NO SIGNAL. OFF-WRITEUP-1, BD-16.
 *
 * THE PROBLEM. The write-up saves itself as the technician types, and offline
 * every one of those saves fails. The panel said so honestly — "your text is
 * still here and has not been lost" — but it was only in a React state
 * variable, so the tablet locking, the battery going flat or the application
 * being closed took three paragraphs of fault findings with it. That is the
 * single most tedious thing in the job card to retype, and it is typed in
 * exactly the places with no coverage.
 *
 * WHAT THIS IS. A LOCAL DRAFT, AND IT IS CALLED THAT EVERYWHERE. It is the
 * technician's own text, kept on their own device, under their own id. It is
 * not a queued request and it is NEVER sent by itself:
 *
 *   - NOTHING REPLAYS IT. The flush in `usePendingWork` does not know this
 *     store exists. A write-up REPLACES a value on the job, and replaying a
 *     replacement hours later is the silent overwrite CR-02 forbids — which is
 *     why `save_report` stays online-only in `offline-rules.ts` and why this
 *     is a draft rather than a fifth queued action.
 *   - THE TECHNICIAN PUTS IT ON THE JOB. When there is a connection the panel
 *     offers the draft back; loading it into the form and saving is the
 *     ordinary online write, with the server's own validation, the ordinary
 *     audit line and the ordinary editability rules. The office's copy is
 *     never touched by anything in this file.
 *   - IT IS NEVER AUTHORITY. A draft is not a saved write-up, is not shown as
 *     one, and nothing reads it to decide whether a job may be signed.
 *
 * WHOSE IT IS. BD-16, the same rule the pending-work store holds: the key
 * carries the user id, every read filters by it and every write names it, so
 * the next technician on a shared tablet neither sees nor can reach it. It is
 * not encrypted and this file claims nothing of the sort — it is an
 * application-level account boundary on an ordinary IndexedDB record.
 *
 * It survives a sign-out deliberately (`clearCachedJobs` names neither this
 * store nor `pending`), because a technician who signs out at the gate has not
 * thrown their write-up away.
 */

const DATABASE = 'eje-job-cache';
const DRAFT_STORE = 'drafts';

export interface ReportDraft {
  /** `<userId>:<jobId>`. One draft per technician per job. */
  readonly key: string;
  readonly userId: string;
  readonly jobId: string;
  /** Carried so a list can name the job without the cache being present. */
  readonly jobNumber: string;
  readonly report: JobCompletionReport;
  readonly savedAt: string;
}

export const isDraftSupported = (): boolean =>
  typeof globalThis !== 'undefined' && typeof globalThis.indexedDB !== 'undefined';

const request = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });

/**
 * Opens the shared database WITHOUT naming a version.
 *
 * `job-cache.ts` owns the schema and its upgrades, exactly as in
 * `pending-work.ts`: opening at no version here means this module can never
 * race it into a downgrade.
 */
const openDatabase = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const open = globalThis.indexedDB.open(DATABASE);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error('IndexedDB could not be opened'));
  });

const withStore = async <T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => Promise<T> | T,
): Promise<T> => {
  const db = await openDatabase();
  try {
    if (!db.objectStoreNames.contains(DRAFT_STORE)) {
      throw new Error('The draft store does not exist in this database.');
    }
    const transaction = db.transaction([DRAFT_STORE], mode);
    const result = await work(transaction.objectStore(DRAFT_STORE));
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error('aborted'));
      transaction.onerror = () => reject(transaction.error ?? new Error('failed'));
    });
    return result;
  } finally {
    db.close();
  }
};

const draftKey = (userId: string, jobId: string): string => `${userId}:${jobId}`;

/** Keeps the text on the device. Called when a save could not be made. */
export const saveReportDraft = async (input: {
  readonly userId: string;
  readonly jobId: string;
  readonly jobNumber: string;
  readonly report: JobCompletionReport;
}): Promise<ReportDraft | null> => {
  if (!isDraftSupported() || input.userId.length === 0) return null;
  const draft: ReportDraft = {
    key: draftKey(input.userId, input.jobId),
    userId: input.userId,
    jobId: input.jobId,
    jobNumber: input.jobNumber,
    report: input.report,
    savedAt: new Date().toISOString(),
  };
  await withStore('readwrite', (store) => {
    store.put(draft);
  });
  return draft;
};

/** This technician's draft for this job, or null. Never anybody else's. */
export const readReportDraft = async (
  userId: string,
  jobId: string,
): Promise<ReportDraft | null> => {
  if (!isDraftSupported() || userId.length === 0) return null;
  return withStore('readonly', async (store) => {
    const found = await request<ReportDraft | undefined>(
      store.get(draftKey(userId, jobId)) as IDBRequest<ReportDraft | undefined>,
    );
    // The key carries the user id, and this is the second check of it: a
    // record that does not belong to this user is not returned, whatever key
    // it was found under.
    return found !== undefined && found.userId === userId ? found : null;
  }).catch(() => null);
};

/** Every draft this technician is holding, newest first. */
export const readReportDrafts = async (userId: string): Promise<readonly ReportDraft[]> => {
  if (!isDraftSupported() || userId.length === 0) return [];
  const rows = await withStore('readonly', (store) =>
    request<ReportDraft[]>(
      store.index('userId').getAll(IDBKeyRange.only(userId)) as IDBRequest<ReportDraft[]>,
    ),
  ).catch(() => [] as ReportDraft[]);
  return [...rows].sort((left, right) => right.savedAt.localeCompare(left.savedAt));
};

/**
 * The draft is finished with: either the server has the text now, or the
 * technician has deliberately thrown it away.
 *
 * Owner-scoped like every other write here, so one technician cannot discard
 * another's work from a shared tablet.
 */
export const discardReportDraft = async (userId: string, jobId: string): Promise<void> => {
  if (!isDraftSupported() || userId.length === 0) return;
  await withStore('readwrite', async (store) => {
    const key = draftKey(userId, jobId);
    const found = await request<ReportDraft | undefined>(
      store.get(key) as IDBRequest<ReportDraft | undefined>,
    );
    if (found === undefined || found.userId !== userId) return;
    store.delete(key);
  }).catch(() => undefined);
};

/** Whether a draft says anything the given report does not. */
export const draftDiffersFrom = (
  draft: ReportDraft,
  report: JobCompletionReport,
): boolean =>
  (Object.keys(draft.report) as (keyof JobCompletionReport)[]).some(
    (field) => draft.report[field] !== report[field],
  );
