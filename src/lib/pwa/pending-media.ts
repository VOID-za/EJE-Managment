import type { MediaVisibility } from '@/domain';

/**
 * PHOTOGRAPHS TAKEN WITH NO SIGNAL. OFF-MEDIA-1, OFF-3, OFF-12, BD-16.
 *
 * THE FAILURE THIS EXISTS FOR. A technician photographs a burnt contactor in a
 * plant basement. The upload fails, the screen says so honestly — and the file
 * is in a React state variable, so the tablet locking, the battery going flat
 * or the application being closed loses the only photograph of the fault, taken
 * at the only moment it could be taken. The machine is reassembled by then.
 *
 * WHY THIS WAS NOT BUILT BEFORE, and what changed. OFF-12 refused offline media
 * on two grounds: bytes are not fields, and megabytes held on a device had no
 * agreed retention rule. The first is a reason to keep them out of the CAPTURE
 * queue — which they are: this is a separate store with its own flush, because
 * a photograph is not a request with a JSON body. The second is answered here,
 * explicitly, and the rule is deliberately conservative:
 *
 *   - A HELD PHOTOGRAPH LEAVES ONLY TWO WAYS: the server accepts it, or the
 *     technician discards it in an explicit confirmed action. Nothing expires,
 *     nothing is evicted to make room, and a sign-out keeps it (BD-16) — the
 *     same rule as unsent captures, for the same reason.
 *   - THERE IS A CEILING, and it is refused at the door rather than enforced by
 *     deletion. A device will hold `MAX_HELD_FILES` photographs totalling
 *     `MAX_HELD_BYTES`; past that, the capture is REFUSED and the technician is
 *     told, because quietly dropping the oldest photograph of a fault would be
 *     worse than saying "this tablet is full".
 *   - IT IS NEVER AUTHORITY. A held photograph is not on the job, is shown as
 *     held, and is not counted among the job's media.
 *
 * ONE UPLOAD PATH, NOT TWO. The flush sends through the same authenticated
 * multipart routes the online capture uses, with the same server-side sniffing,
 * the same authorisation and the same idempotency key minted at capture — so a
 * photograph whose bytes landed before the connection died is replayed rather
 * than attached twice. There is no second mechanism and no "offline upload"
 * endpoint.
 *
 * WHAT IT IS NOT: a resume. A file that fails is re-sent WHOLE, and only that
 * file — the queue does not re-send the ones that landed. Byte-range resume
 * needs a chunked upload protocol on both sides, which is a decision nobody has
 * made (OFF-7, still PARTIAL, and said so in `docs/SCOPE.md`).
 *
 * WHOSE IT IS. Every read filters by user and every write names one, exactly as
 * in `pending-work.ts`: on a shared tablet the next technician neither sees
 * another person's photographs nor can send, retry or discard them. Not
 * encryption — an application-level account boundary on ordinary IndexedDB
 * records, with the device's own screen lock underneath it.
 */

const DATABASE = 'eje-job-cache';
const MEDIA_STORE = 'media';

/** The shape this build writes. Bumped when the row's meaning changes. */
export const MEDIA_SCHEMA_VERSION = 1;

/** At most this many photographs, totalling at most this many bytes, per user. */
export const MAX_HELD_FILES = 25;
export const MAX_HELD_BYTES = 40 * 1024 * 1024;

/**
 * Where a held photograph is going.
 *
 * A discriminated union rather than a URL, because a URL in the store would be
 * a route this build happened to use, replayed by a later build against an
 * endpoint that may have moved. The flush resolves each kind to the SAME client
 * function the online capture calls.
 */
export type MediaDestination =
  | { readonly kind: 'job_photo'; readonly visibility: MediaVisibility }
  | { readonly kind: 'checklist_evidence'; readonly itemId: string }
  /** BD-14: a machine photograph, authorised by the job it was taken on. */
  | { readonly kind: 'machine_photo'; readonly machineId: string };

export type PendingMediaState = 'pending' | 'conflict';

export interface PendingMedia {
  /** This device's own id for the capture. Not a server id. */
  readonly id: string;
  readonly schemaVersion: number;
  readonly userId: string;
  readonly jobId: string;
  readonly jobNumber: string;
  readonly destination: MediaDestination;
  readonly fileName: string;
  readonly contentType: string;
  /** The real bytes. An ArrayBuffer, which IndexedDB stores structurally. */
  readonly bytes: ArrayBuffer;
  readonly sizeBytes: number;
  readonly caption: string;
  /** Minted ONCE, at capture. Reused for every attempt, which is what makes a
   * retry safe: the server replays the first answer instead of storing twice. */
  readonly idempotencyKey: string;
  readonly capturedAt: string;
  readonly state: PendingMediaState;
  readonly attempts: number;
  /** The server's own words, when it refused. */
  readonly lastError: string | null;
  readonly lastErrorCode: string | null;
}

/** Told when the store changes, so every screen showing it agrees. */
const listeners = new Set<() => void>();

export const onPendingMediaChanged = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const announce = (): void => {
  for (const listener of listeners) listener();
};

export const isMediaQueueSupported = (): boolean =>
  typeof globalThis !== 'undefined' && typeof globalThis.indexedDB !== 'undefined';

const request = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });

/** Opens the shared database WITHOUT a version; `job-cache.ts` owns upgrades. */
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
    if (!db.objectStoreNames.contains(MEDIA_STORE)) {
      throw new Error('The held-photograph store does not exist in this database.');
    }
    const transaction = db.transaction([MEDIA_STORE], mode);
    const result = await work(transaction.objectStore(MEDIA_STORE));
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

/** Everything this user is holding, oldest capture first. */
export const readPendingMedia = async (userId: string): Promise<readonly PendingMedia[]> => {
  if (!isMediaQueueSupported() || userId.length === 0) return [];
  const rows = await withStore('readonly', (store) =>
    request<PendingMedia[]>(
      store.index('userId').getAll(IDBKeyRange.only(userId)) as IDBRequest<PendingMedia[]>,
    ),
  ).catch(() => [] as PendingMedia[]);

  // Capture order: the order the technician photographed the work in, which is
  // the order the job's media should end up in.
  return [...rows].sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
};

/** This user's held photographs for one job. */
export const readPendingMediaForJob = async (
  userId: string,
  jobId: string,
): Promise<readonly PendingMedia[]> =>
  (await readPendingMedia(userId)).filter((row) => row.jobId === jobId);

export interface HoldMediaInput {
  readonly userId: string;
  readonly jobId: string;
  readonly jobNumber: string;
  readonly destination: MediaDestination;
  readonly file: File;
  readonly caption: string;
  readonly idempotencyKey: string;
}

export interface HoldOutcome {
  readonly held: boolean;
  /** Why not, in words a technician standing at a machine can act on. */
  readonly reason: string | null;
}

/**
 * Keeps one photograph on this device.
 *
 * REFUSES RATHER THAN EVICTS when the device is full, and says which limit was
 * reached. A queue that silently dropped the oldest photograph would lose
 * exactly the evidence the technician was told was safe.
 */
export const holdMedia = async (input: HoldMediaInput): Promise<HoldOutcome> => {
  if (!isMediaQueueSupported() || input.userId.length === 0) {
    return { held: false, reason: 'This tablet cannot hold photographs for later.' };
  }

  const existing = await readPendingMedia(input.userId);
  if (existing.length >= MAX_HELD_FILES) {
    return {
      held: false,
      reason: `This tablet is already holding ${existing.length} photographs, which is the limit. Send them when you have signal before taking more.`,
    };
  }
  const held = existing.reduce((total, row) => total + row.sizeBytes, 0);
  if (held + input.file.size > MAX_HELD_BYTES) {
    return {
      held: false,
      reason:
        'This tablet is holding as many photographs as it can. Send them when you have signal before taking more.',
    };
  }

  const bytes = await input.file.arrayBuffer();
  const row: PendingMedia = {
    id: globalThis.crypto.randomUUID(),
    schemaVersion: MEDIA_SCHEMA_VERSION,
    userId: input.userId,
    jobId: input.jobId,
    jobNumber: input.jobNumber,
    destination: input.destination,
    fileName: input.file.name.length > 0 ? input.file.name : 'photograph.jpg',
    contentType: input.file.type.length > 0 ? input.file.type : 'image/jpeg',
    bytes,
    sizeBytes: bytes.byteLength,
    caption: input.caption,
    idempotencyKey: input.idempotencyKey,
    capturedAt: new Date().toISOString(),
    state: 'pending',
    attempts: 0,
    lastError: null,
    lastErrorCode: null,
  };

  await withStore('readwrite', (store) => {
    store.put(row);
  });
  announce();
  return { held: true, reason: null };
};

/** The bytes, as the upload path wants them. */
export const fileFrom = (row: PendingMedia): File =>
  new File([row.bytes], row.fileName, { type: row.contentType });

const ownedBy = (userId: string, row: PendingMedia | undefined): row is PendingMedia =>
  row !== undefined && row.userId === userId;

const update = async (
  userId: string,
  id: string,
  change: (row: PendingMedia) => PendingMedia,
): Promise<void> => {
  if (!isMediaQueueSupported() || userId.length === 0) return;
  await withStore('readwrite', async (store) => {
    const found = await request<PendingMedia | undefined>(
      store.get(id) as IDBRequest<PendingMedia | undefined>,
    );
    // BD-16: somebody else's photograph, or none. Either way nothing is written.
    if (!ownedBy(userId, found)) return;
    store.put(change(found));
  });
  announce();
};

/** Counts an attempt, keeping the photograph queued. Used before each send. */
export const markMediaAttempt = (userId: string, id: string): Promise<void> =>
  update(userId, id, (row) => ({ ...row, attempts: row.attempts + 1 }));

/** The server refused it, and saying it again will not help. */
export const markMediaConflict = (
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
export const markMediaUnsent = (
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

/** A refused photograph the technician wants to try once more, as it is. */
export const requeueMedia = (userId: string, id: string): Promise<void> =>
  update(userId, id, (row) => ({ ...row, state: 'pending', lastError: null, lastErrorCode: null }));

/**
 * The server has it. This is the ONLY automatic removal.
 *
 * Called after a 2xx — which, because the key is the capture's own, also covers
 * the replay of an upload that had already committed.
 */
export const completeMedia = async (userId: string, id: string): Promise<void> => {
  if (!isMediaQueueSupported() || userId.length === 0) return;
  await withStore('readwrite', async (store) => {
    const found = await request<PendingMedia | undefined>(
      store.get(id) as IDBRequest<PendingMedia | undefined>,
    );
    if (!ownedBy(userId, found)) return;
    store.delete(id);
  });
  announce();
};

/**
 * The technician has decided to abandon this photograph.
 *
 * Only ever from an explicit, confirmed action on a row they can see — the one
 * circumstance in which captured work may be destroyed (CR-02).
 */
export const discardMedia = completeMedia;

/** What this device is holding, for a screen that has to say so. */
export const heldMediaSummary = (
  rows: readonly PendingMedia[],
): { readonly count: number; readonly bytes: number } => ({
  count: rows.length,
  bytes: rows.reduce((total, row) => total + row.sizeBytes, 0),
});
