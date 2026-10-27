import {
  canCaptureOffline,
  isOfflineSignatureAction,
  type CaptureContext,
  type OfflineAction,
} from './offline-rules';

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

export type PendingState =
  /** On this tablet, waiting for a connection. */
  | 'pending'
  /**
   * The server refused it and a person has to decide. BD-15.
   *
   * A transient state now: the tablet refers it to the office immediately,
   * because it has a connection — the refusal came from the server. It stays
   * only when the referral itself could not be sent, so the next flush tries
   * again.
   */
  | 'conflict'
  /**
   * Referred to the office, which has it. BD-15.
   *
   * Nothing retries from here: the capture is server-side now and the office
   * decides. The local row is kept so the technician can see what became of
   * their work, and is removed once the referral is resolved.
   */
  | 'referred';

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
  /** The office's record of this capture, once it has been referred. BD-15. */
  readonly referralId?: string;
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

/* -------------------------------------------------------------------------- */
/* WHICH CAPTURE IS BEING SENT RIGHT NOW. OFF-QUEUE-4, OFF-8.                 */
/* -------------------------------------------------------------------------- */

/**
 * The captures currently in flight, and why this is NOT a stored state.
 *
 * A technician with twelve captures queued used to see one spinner on a *Send*
 * button and no idea which of the twelve was moving — on a bad link that reads
 * as nothing happening. So each row says "sending" while its own request is
 * open.
 *
 * IT IS DELIBERATELY IN MEMORY. A `sending` written into IndexedDB would
 * survive the tablet being killed mid-request, and on the next launch the
 * queue would show a row as sending with nothing sending it — a lie that only
 * a person could clear. Held like this, the truth after a crash is the honest
 * one: the row is `pending` again, and the next flush re-sends it under the
 * same idempotency key.
 */
const sending = new Set<string>();

export const markSending = (id: string): void => {
  sending.add(id);
  announce();
};

export const clearSending = (id: string): void => {
  if (!sending.delete(id)) return;
  announce();
};

/** The ids of the captures whose request is open right now. */
export const sendingIds = (): readonly string[] => [...sending];

/** For tests, and for a sign-out: nothing is in flight any more. */
export const resetSending = (): void => {
  if (sending.size === 0) return;
  sending.clear();
  announce();
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

/**
 * WHOSE ROW THIS IS. BD-16.
 *
 * A tablet is shared. Sipho captures three hours in a basement, hands the
 * tablet to Riaan at the gate, and Riaan signs in — and from that moment the
 * only honest thing to do with Sipho's unsent hours is keep them and show them
 * to nobody. `readPendingWork` has always filtered by user, so they are not
 * DISPLAYED to Riaan; this is the other half, which is that they cannot be
 * REACHED either.
 *
 * Every write below names the user it is acting for, and a row belonging to
 * somebody else is left exactly as it is. Enforced here rather than in the
 * screen that lists the rows, because hiding a control is not authorisation:
 * a row id that leaked into a log, a stale component or a future caller must
 * not be a way to send, retry, requeue or discard another technician's work.
 *
 * WHAT THIS IS NOT. It is not encryption and this file does not pretend
 * otherwise: the rows are ordinary IndexedDB records, and anyone with the
 * device and a browser console can read the database directly. It is an
 * application-level account boundary, and the device-level one is the tablet's
 * own screen lock and EJE's device policy — see `docs/tablet-installation.md`.
 * What is NOT here is anything worth stealing twice: no password, no session
 * cookie and no access token is ever written to this store (OFF-SEC-1).
 */
const ownedBy = (userId: string, row: PendingWork | undefined): row is PendingWork =>
  row !== undefined && row.userId === userId;

const update = async (
  userId: string,
  id: string,
  change: (row: PendingWork) => PendingWork,
): Promise<void> => {
  if (!isPendingSupported() || userId.length === 0) return;
  await withStore('readwrite', async (store) => {
    const found = await request<PendingWork | undefined>(
      store.get(id) as IDBRequest<PendingWork | undefined>,
    );
    // Somebody else's capture, or none. Either way nothing is written.
    if (!ownedBy(userId, found)) return;
    store.put(change(found));
  });
  announce();
};

/** Counts an attempt, keeping the row queued. Used before each send. */
export const markAttempt = (userId: string, id: string): Promise<void> =>
  update(userId, id, (row) => ({ ...row, attempts: row.attempts + 1 }));

/**
 * The server refused it, and saying it again will not help.
 *
 * The row stays, with the server's own message on it, until a person decides.
 * `attempts` is not reset: how many times this was tried is part of what the
 * technician is looking at.
 */
export const markConflict = (
  userId: string,
  id: string,
  error: { readonly message: string; readonly code: string | null },
): Promise<void> =>
  update(userId, id, (row) => ({
    ...row,
    state: 'conflict',
    lastError: error.message,
    lastErrorCode: error.code,
  }));

/** Nothing was decided — the request did not arrive. It stays queued. */
export const markUnsent = (
  userId: string,
  id: string,
  error: { readonly message: string; readonly code: string | null },
): Promise<void> =>
  update(userId, id, (row) => ({
    ...row,
    state: 'pending',
    lastError: error.message,
    lastErrorCode: error.code,
  }));

/** A conflicted row the technician wants to try once more, as it stands. */
export const requeueWork = (userId: string, id: string): Promise<void> =>
  update(userId, id, (row) => ({ ...row, state: 'pending', lastError: null, lastErrorCode: null }));

/**
 * The office has it. BD-15.
 *
 * The row stops being the tablet's problem and becomes a record of where the
 * work went. Nothing replays from this state — that is the point of referring
 * it — and the row leaves only when the referral is resolved.
 */
export const markReferred = (userId: string, id: string, referralId: string): Promise<void> =>
  update(userId, id, (row) => ({ ...row, state: 'referred', referralId }));

/**
 * A HELD ANSWER THE TECHNICIAN HAS JUST REPLACED. OFF-CHK-1.
 *
 * A checklist answer is the one capture in this store that is not a new row:
 * answering the same item twice offline is one answer, corrected, not two
 * findings. So holding an answer removes the UNSENT one it replaces.
 *
 * NARROW ON PURPOSE, and the conditions are the whole safety of it: the same
 * user, the same job, the same item, the same action, and `pending` — a
 * capture the server has refused (`conflict`) or the office is deciding about
 * (`referred`) is nobody's to tidy away from here, and is left exactly where
 * it is. Nothing that ever reached the server can be removed by this.
 *
 * Without it, two answers for one item would both be sent: the first would
 * land and the second would be refused for replacing an answer that is no
 * longer the one it expected — a conflict the technician would have to have
 * explained to them, caused entirely by them changing their mind.
 */
export const supersedePendingAnswer = async (
  userId: string,
  jobId: string,
  itemId: string,
): Promise<number> => {
  if (!isPendingSupported() || userId.length === 0) return 0;
  const superseded = (await readPendingWork(userId)).filter(
    (row) =>
      row.jobId === jobId &&
      row.action === 'answer_checklist' &&
      row.state === 'pending' &&
      row.payload.itemId === itemId,
  );
  if (superseded.length === 0) return 0;

  await withStore('readwrite', (store) => {
    for (const row of superseded) store.delete(row.id);
  });
  announce();
  return superseded.length;
};

/**
 * The server has it. This is the ONLY automatic removal.
 *
 * Called after a 2xx, which — because the key is the capture's own — also
 * covers the replay of a request that had already committed.
 */
export const completeWork = async (userId: string, id: string): Promise<void> => {
  if (!isPendingSupported() || userId.length === 0) return;
  await withStore('readwrite', async (store) => {
    const found = await request<PendingWork | undefined>(
      store.get(id) as IDBRequest<PendingWork | undefined>,
    );
    // BD-16: deleting is a write like any other, and the loudest one — a row
    // belonging to another technician is not this user's to destroy.
    if (!ownedBy(userId, found)) return;
    store.delete(id);
  });
  announce();
};

/**
 * The technician has decided to abandon this capture.
 *
 * Only ever from an explicit, confirmed action on a row they can see, which is
 * the only circumstance in which captured work may be destroyed (CR-02).
 *
 * NOT A CUSTOMER'S SIGNATURE OR REFUSAL. BD-23. That is the customer's act,
 * not the technician's work, and it is evidence: it leaves the tablet only
 * when the server has accepted it, or once it is REFERRED — the office then
 * holds the same evidence, so removing the tablet's copy loses nothing.
 */
export const discardWork = async (userId: string, id: string): Promise<void> => {
  const row = (await readPendingWork(userId)).find((candidate) => candidate.id === id);
  if (row !== undefined && isOfflineSignatureAction(row.action) && row.state !== 'referred') {
    throw new Error(
      'A customer’s signature or refusal held on this tablet cannot be discarded. It is sent when there is a signal, and the server or the office decides what happens to it.',
    );
  }
  await completeWork(userId, id);
};

/** Emptied only where a technician's device is being wiped deliberately. */
export const clearPendingWork = async (userId: string): Promise<void> => {
  if (!isPendingSupported() || userId.length === 0) return;
  // Already owner-scoped: `readPendingWork` answers this user's rows and no
  // others, so a wipe cannot reach past the account it was asked for.
  const rows = await readPendingWork(userId);
  await withStore('readwrite', (store) => {
    for (const row of rows) store.delete(row.id);
  });
  announce();
};
