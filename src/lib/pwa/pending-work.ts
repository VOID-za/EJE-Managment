import { canCaptureOffline, type CaptureContext, type OfflineAction } from './offline-rules';

/**
 * WORK CAPTURED ON THE TABLET THAT THE SERVER HAS NOT SEEN. OFF-1, OFF-6,
 * OFF-8, CR-09 Phase 4 step one.
 *
 * THE ONE STORE IN THIS APPLICATION THAT HOLDS SOMETHING IRREPLACEABLE. The
 * job cache is a copy of what the server said and can be thrown away at any
 * time; these rows are hours a technician worked, kilometres they drove and
 * parts they fitted, typed in a plant with no signal. Losing one is losing the
 * only record of it. Three consequences run through everything below:
 *
 *   1. NOTHING IS EVER DELETED EXCEPT BY THE SERVER CONFIRMING IT, or by the
 *      technician explicitly discarding it. Not on sign-out, not on a session
 *      expiring, not on another user signing in — see `clearCachedJobs`, which
 *      deliberately leaves this store alone.
 *   2. EVERY ROW CARRIES ITS OWN IDEMPOTENCY KEY, minted once at capture. A
 *      replay of the same row is the same request, so a flush interrupted
 *      between the server committing and the answer arriving cannot double the
 *      hours (`writeRoute`'s idempotency, which is keyed to the actor, the
 *      operation and the body).
 *   3. A ROW IS NEVER AUTHORITY. It is a request the server has not yet ruled
 *      on. The screen says `pending`, and only the server's acceptance turns
 *      that into "on the job".
 *
 * `schemaVersion` is on the row rather than implied by the database version,
 * because these rows outlive upgrades: a row written by an older build must be
 * recognisable — and, if it cannot be understood, surfaced rather than
 * silently dropped.
 */

const DATABASE = 'eje-job-cache';
const PENDING_STORE = 'pending';

/** The shape this build writes. Bumped when the row's meaning changes. */
export const PENDING_SCHEMA_VERSION = 1;

export type PendingState = 'pending' | 'conflict';

export interface PendingWork {
  /** This device's own id for the capture. Not a server id. */
  readonly id: string;
  readonly schemaVersion: number;
  readonly userId: string;
  readonly jobId: string;
  /** Carried so the screen can name the job without the cache being present. */
  readonly jobNumber: string;
  readonly action: OfflineAction;
  /** Exactly the body the API takes for `action`, validated at capture. */
  readonly payload: Readonly<Record<string, unknown>>;
  /** One line, for the list: "3.5 h normal — Replaced the drive fan". */
  readonly summary: string;
  /** Minted ONCE. Reused for every attempt, which is what makes retry safe. */
  readonly idempotencyKey: string;
  readonly capturedAt: string;
  readonly state: PendingState;
  readonly attempts: number;
  /** The server's own words, when it refused. */
  readonly lastError: string | null;
  readonly lastErrorCode: string | null;
  /** What the device believed about the job when this was captured. */
  readonly context: CaptureContext;
}

/**
 * Told when the queue changes, so every screen showing it agrees.
 *
 * The same idiom as `onSessionEnded` in the API client, and for the same
 * reason: the store is outside React, several screens read it at once (the job
 * screen, the job list, the sign-out guard), and a capture queued in one panel
 * has to appear in the others immediately. Without this, a technician who
 * captured hours offline would see nothing until the next navigation — which
 * reads exactly like the capture having been dropped.
 */
const listeners = new Set<() => void>();

export const onPendingWorkChanged = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const announce = (): void => {
  for (const listener of listeners) listener();
};

export const isPendingSupported = (): boolean =>
  typeof globalThis !== 'undefined' && typeof globalThis.indexedDB !== 'undefined';

const request = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });

/**
 * Opens the shared database WITHOUT naming a version.
 *
 * `job-cache.ts` owns the schema and its upgrades; opening at no version here
 * means this module can never race it into a downgrade, and a build where the
 * store has not been created yet fails loudly on the transaction rather than
 * quietly rewriting the database.
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
    if (!db.objectStoreNames.contains(PENDING_STORE)) {
      throw new Error('The pending-work store does not exist in this database.');
    }
    const transaction = db.transaction([PENDING_STORE], mode);
    const result = await work(transaction.objectStore(PENDING_STORE));
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

export interface QueueInput {
  readonly userId: string;
  readonly jobId: string;
  readonly jobNumber: string;
  readonly action: OfflineAction;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly summary: string;
  readonly idempotencyKey: string;
  readonly context: CaptureContext;
}

/**
 * Holds one capture on this device.
 *
 * The offline rules are applied HERE as well as in the screen, because this is
 * the function that makes a row durable: a capture that should never have been
 * taken offline must not be able to reach the store through some other caller
 * and then be replayed days later.
 */
export const queueWork = async (input: QueueInput): Promise<PendingWork> => {
  if (!isPendingSupported()) {
    throw new Error('This browser cannot hold work on the device.');
  }
  const verdict = canCaptureOffline(input.action, input.context);
  if (!verdict.allowed) throw new Error(verdict.reason ?? 'That cannot be captured offline.');

  const row: PendingWork = {
    id: globalThis.crypto.randomUUID(),
    schemaVersion: PENDING_SCHEMA_VERSION,
    userId: input.userId,
    jobId: input.jobId,
    jobNumber: input.jobNumber,
    action: input.action,
    payload: input.payload,
    summary: input.summary,
    idempotencyKey: input.idempotencyKey,
    capturedAt: new Date().toISOString(),
    state: 'pending',
    attempts: 0,
    lastError: null,
    lastErrorCode: null,
    context: input.context,
  };

  await withStore('readwrite', (store) => {
    store.put(row);
  });
  announce();
  return row;
};

/** Everything this user is still holding, oldest capture first. */
export const readPendingWork = async (userId: string): Promise<readonly PendingWork[]> => {
  if (!isPendingSupported() || userId.length === 0) return [];
  const rows = await withStore('readonly', (store) =>
    request<PendingWork[]>(
      store.index('userId').getAll(IDBKeyRange.only(userId)) as IDBRequest<PendingWork[]>,
    ),
  ).catch(() => [] as PendingWork[]);

  /*
   * ORDER IS THE CAPTURE ORDER, because that is the order the technician did
   * the work in and the order the server should receive it (ACC-OFF-7). Rows
   * written by a future build are kept and shown, never dropped — they are
   * somebody's work — but they are not replayed by a build that cannot
   * understand them.
   */
  return [...rows].sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
};

/** This user's captures against one job. */
export const readPendingForJob = async (
  userId: string,
  jobId: string,
): Promise<readonly PendingWork[]> =>
  (await readPendingWork(userId)).filter((row) => row.jobId === jobId);

const update = async (id: string, change: (row: PendingWork) => PendingWork): Promise<void> => {
  if (!isPendingSupported()) return;
  await withStore('readwrite', async (store) => {
    const found = await request<PendingWork | undefined>(
      store.get(id) as IDBRequest<PendingWork | undefined>,
    );
    if (found === undefined) return;
    store.put(change(found));
  });
  announce();
};

/** Counts an attempt, keeping the row queued. Used before each send. */
export const markAttempt = (id: string): Promise<void> =>
  update(id, (row) => ({ ...row, attempts: row.attempts + 1 }));

/**
 * The server refused it, and saying it again will not help.
 *
 * The row stays, with the server's own message on it, until a person decides.
 * `attempts` is not reset: how many times this was tried is part of what the
 * technician is looking at.
 */
export const markConflict = (
  id: string,
  error: { readonly message: string; readonly code: string | null },
): Promise<void> =>
  update(id, (row) => ({
    ...row,
    state: 'conflict',
    lastError: error.message,
    lastErrorCode: error.code,
  }));

/** Nothing was decided — the request did not arrive. It stays queued. */
export const markUnsent = (
  id: string,
  error: { readonly message: string; readonly code: string | null },
): Promise<void> =>
  update(id, (row) => ({
    ...row,
    state: 'pending',
    lastError: error.message,
    lastErrorCode: error.code,
  }));

/** A conflicted row the technician wants to try once more, as it stands. */
export const requeueWork = (id: string): Promise<void> =>
  update(id, (row) => ({ ...row, state: 'pending', lastError: null, lastErrorCode: null }));

/**
 * The server has it. This is the ONLY automatic removal.
 *
 * Called after a 2xx, which — because the key is the capture's own — also
 * covers the replay of a request that had already committed.
 */
export const completeWork = async (id: string): Promise<void> => {
  if (!isPendingSupported()) return;
  await withStore('readwrite', (store) => {
    store.delete(id);
  });
  announce();
};

/**
 * The technician has decided to abandon this capture.
 *
 * Only ever from an explicit, confirmed action on a row they can see, which is
 * the only circumstance in which captured work may be destroyed (CR-02).
 */
export const discardWork = completeWork;

/** Emptied only where a technician's device is being wiped deliberately. */
export const clearPendingWork = async (userId: string): Promise<void> => {
  if (!isPendingSupported() || userId.length === 0) return;
  const rows = await readPendingWork(userId);
  await withStore('readwrite', (store) => {
    for (const row of rows) store.delete(row.id);
  });
  announce();
};
