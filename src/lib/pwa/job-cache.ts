import { toCachedJob, type CachedJob } from './cached-job';
import type { JobListRow } from '@/application/job-view';

/**
 * THE TECHNICIAN'S ASSIGNED JOBS, ON THE DEVICE. PWA-6, CR-09 Phase 3.
 *
 * IndexedDB and not `localStorage`, for three reasons that all matter on a
 * rugged tablet: it is asynchronous, so a list of jobs never blocks the frame
 * a technician is tapping; it holds structured records rather than one string
 * the whole application has to parse; and it has a real size budget instead of
 * the few megabytes `localStorage` is held to.
 *
 * WHAT THIS IS NOT. It is a READ cache. Nothing here queues a change, replays
 * one, or lets a job be edited offline — that is Phase 4 and may not be built
 * until the phase is scoped (CR-02's promise about silent overwrites depends
 * on an agreed definition of a conflict, and there is none yet). The only
 * writes are "store what the server just said" and "forget it".
 *
 * THE SHARED-TABLET RULE, which is the part worth being careful about. One
 * tablet is used by whoever is on shift. Every record is written under the
 * signed-in user's id and every read is filtered by it, so a cached job cannot
 * be shown to the next person — and `clearCachedJobs` empties the store
 * outright when a session ends, so it is not merely hidden. A record is never
 * authority either: it is what the server said, and every action still asks
 * the server, which decides on the session.
 */

const DATABASE = 'eje-job-cache';
const DATABASE_VERSION = 3;
const JOB_STORE = 'jobs';
const META_STORE = 'meta';
const DEVICE_STORE = 'device';
const PLACE_STORE = 'place';
const PENDING_STORE = 'pending';
/** One row, so the key is fixed: this device has one last-confirmed session. */
const DEVICE_KEY = 'last_confirmed_session';

export interface CachedJobRecord extends CachedJob {
  /** `<userId>:<jobNumber>`. The user id is part of the key, not a column. */
  readonly key: string;
  readonly userId: string;
}

export interface CacheMeta {
  readonly userId: string;
  readonly lastRefreshedAt: string;
  readonly jobCount: number;
}

/**
 * WHOSE SESSION THIS DEVICE LAST SAW CONFIRMED BY THE SERVER.
 *
 * Needed because of one specific moment: the tablet is offline, so
 * `/api/auth/me` cannot answer, and the offline page has to know whose cached
 * jobs — if anybody's — it is entitled to show. Without this it would either
 * show nothing at all, which makes the whole cache pointless in the yard where
 * it matters, or guess, which is worse.
 *
 * IT IS NOT AN OFFLINE SESSION AND IT GRANTS NOTHING. It is written only after
 * the server has answered an authenticated read, it holds no token, and
 * everything it unlocks is read-only data this device was already given. Every
 * action still goes to the server. Offline AUTHENTICATION — a technician
 * signing in or keeping a session alive through a shift with no signal — is
 * OFF-10, which is Phase 4 and deliberately not decided here.
 *
 * It goes when the cache goes: a sign-out, a revoked session, or another user
 * signing in all remove it.
 */
export interface DeviceSession {
  readonly key: string;
  readonly userId: string;
  readonly confirmedAt: string;
}

/**
 * WHERE THIS TECHNICIAN WAS WHEN THE TABLET STOPPED. PWA-4.
 *
 * A rugged tablet in a plant gets locked, put down, carried out of range and
 * run flat, and the application it reopens on is a fresh document with a fresh
 * history — the browser's back button does not survive a battery going dead.
 * This is one record per user holding the job they last had open, so the job
 * list can offer to take them back to it rather than making them find it in a
 * list of thirty.
 *
 * A JOB NUMBER, AND NOTHING ELSE. No captured work is kept here and none could
 * be: there is no local draft in Phase 3, so the state being recovered is
 * navigation, not data. Anything the technician typed and did not send is gone
 * and the application says so rather than implying otherwise — keeping work
 * locally is OFF-1 and belongs to Phase 4.
 */
export interface LastPlace {
  readonly userId: string;
  readonly jobNumber: string;
  readonly openedAt: string;
}

/** True where this browser has IndexedDB at all. A desktop test runner has not. */
export const isJobCacheSupported = (): boolean =>
  typeof globalThis !== 'undefined' && typeof globalThis.indexedDB !== 'undefined';

const request = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });

const openDatabase = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const open = globalThis.indexedDB.open(DATABASE, DATABASE_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(JOB_STORE)) {
        const store = db.createObjectStore(JOB_STORE, { keyPath: 'key' });
        // Reading one technician's jobs is the only query this store serves.
        store.createIndex('userId', 'userId', { unique: false });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'userId' });
      }
      if (!db.objectStoreNames.contains(DEVICE_STORE)) {
        db.createObjectStore(DEVICE_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(PLACE_STORE)) {
        db.createObjectStore(PLACE_STORE, { keyPath: 'userId' });
      }
      /*
       * WORK THIS DEVICE IS HOLDING FOR THE SERVER. OFF-1, OFF-6.
       *
       * The only store here whose contents are not a copy of something the
       * server already has — so it is the only one whose loss would lose a
       * technician's work, and the one place in this file where "clear it on
       * sign-out" would be the wrong instinct. See `clearCachedJobs`.
       */
      if (!db.objectStoreNames.contains(PENDING_STORE)) {
        const pending = db.createObjectStore(PENDING_STORE, { keyPath: 'id' });
        pending.createIndex('userId', 'userId', { unique: false });
        pending.createIndex('jobId', 'jobId', { unique: false });
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error('IndexedDB could not be opened'));
  });

const withStores = async <T>(
  mode: IDBTransactionMode,
  work: (
    jobs: IDBObjectStore,
    meta: IDBObjectStore,
    device: IDBObjectStore,
    place: IDBObjectStore,
  ) => Promise<T> | T,
): Promise<T> => {
  const db = await openDatabase();
  try {
    const transaction = db.transaction(
      [JOB_STORE, META_STORE, DEVICE_STORE, PLACE_STORE],
      mode,
    );
    const result = await work(
      transaction.objectStore(JOB_STORE),
      transaction.objectStore(META_STORE),
      transaction.objectStore(DEVICE_STORE),
      transaction.objectStore(PLACE_STORE),
    );
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

/** `<userId>:<jobNumber>` — the user is in the key, so a read cannot stray. */
export const cacheKey = (userId: string, jobNumber: string): string => `${userId}:${jobNumber}`;

/**
 * Replaces this user's cached jobs with what the server just said.
 *
 * REPLACES, not merges: a job that has left the technician's list — reassigned,
 * cancelled, closed — must leave the tablet too, and a merge would keep it
 * there forever. Other users' records are untouched, because they are not this
 * session's to manage; `clearCachedJobs` is what removes those.
 */
export const cacheJobsFor = async (
  userId: string,
  rows: readonly JobListRow[],
  refreshedAt: string,
): Promise<number> => {
  if (!isJobCacheSupported() || userId.length === 0) return 0;

  const records: CachedJobRecord[] = rows.map((row) => {
    const job = toCachedJob(row);
    return { ...job, key: cacheKey(userId, job.jobNumber), userId };
  });

  await withStores('readwrite', async (jobs, meta, device) => {
    const existing = await request(jobs.index('userId').getAllKeys(IDBKeyRange.only(userId)));
    for (const key of existing) jobs.delete(key);
    for (const record of records) jobs.put(record);
    meta.put({ userId, lastRefreshedAt: refreshedAt, jobCount: records.length } satisfies CacheMeta);
    /*
     * Recorded HERE and nowhere else, because reaching this line means the
     * server answered an authenticated read for this user moments ago. That is
     * the only evidence this device ever has of whose session it holds.
     */
    device.put({
      key: DEVICE_KEY,
      userId,
      confirmedAt: refreshedAt,
    } satisfies DeviceSession);
  });

  return records.length;
};

/** This user's cached jobs, and nobody else's. */
export const readCachedJobs = async (userId: string): Promise<readonly CachedJob[]> => {
  if (!isJobCacheSupported() || userId.length === 0) return [];
  return withStores('readonly', async (jobs) => {
    const records = await request<CachedJobRecord[]>(
      jobs.index('userId').getAll(IDBKeyRange.only(userId)) as IDBRequest<CachedJobRecord[]>,
    );
    return records.map(({ key: _key, userId: _userId, ...job }) => job);
  });
};

/** When this user's cache was last filled, or null if it never was. */
export const readCacheMeta = async (userId: string): Promise<CacheMeta | null> => {
  if (!isJobCacheSupported() || userId.length === 0) return null;
  return withStores('readonly', async (_jobs, meta) => {
    const found = await request<CacheMeta | undefined>(
      meta.get(userId) as IDBRequest<CacheMeta | undefined>,
    );
    return found ?? null;
  });
};

/**
 * Whose session this device last saw confirmed, or null.
 *
 * For the offline page, which cannot ask the server. It is a pointer into this
 * device's own cache and nothing more — see `DeviceSession`.
 */
export const readDeviceSession = async (): Promise<DeviceSession | null> => {
  if (!isJobCacheSupported()) return null;
  return withStores('readonly', async (_jobs, _meta, device) => {
    const found = await request<DeviceSession | undefined>(
      device.get(DEVICE_KEY) as IDBRequest<DeviceSession | undefined>,
    );
    return found ?? null;
  });
};

/**
 * Records the job this user has open, for the reopen after an interruption.
 *
 * Called on arrival at a job, and deliberately not on every tab or panel: the
 * job is the unit of work a technician thinks in, and a promise to restore
 * anything finer than that is a promise Phase 3 cannot keep.
 */
export const rememberLastPlace = async (userId: string, jobNumber: string): Promise<void> => {
  if (!isJobCacheSupported() || userId.length === 0 || jobNumber.length === 0) return;
  await withStores('readwrite', (_jobs, _meta, _device, place) => {
    place.put({
      userId,
      jobNumber,
      openedAt: new Date().toISOString(),
    } satisfies LastPlace);
  });
};

/** Where this user was, or null if this device has never seen them open a job. */
export const readLastPlace = async (userId: string): Promise<LastPlace | null> => {
  if (!isJobCacheSupported() || userId.length === 0) return null;
  return withStores('readonly', async (_jobs, _meta, _device, place) => {
    const found = await request<LastPlace | undefined>(
      place.get(userId) as IDBRequest<LastPlace | undefined>,
    );
    return found ?? null;
  });
};

/** Forgets where this user was — after they have been taken back there. */
export const clearLastPlace = async (userId: string): Promise<void> => {
  if (!isJobCacheSupported() || userId.length === 0) return;
  await withStores('readwrite', (_jobs, _meta, _device, place) => {
    place.delete(userId);
  });
};

/**
 * Empties the CACHE for everybody. Called when a session ends.
 *
 * NOT THE PENDING-WORK STORE, and that is the most important sentence in this
 * file. Everything cleared below is a copy of something the server already
 * has — a job list, when it arrived, whose session this was, which job was
 * open — so throwing it away costs nothing. `pending` holds hours a technician
 * worked and parts they fitted that the server has NOT seen; clearing it on a
 * sign-out would destroy the only record of that work, which is precisely what
 * CR-02 forbids. It is keyed by user, shown only to its owner, and leaves only
 * when the server confirms it or the technician explicitly discards it. See
 * `pending-work.ts`.
 *
 *
 * EVERYBODY, not just the user signing out: a tablet that has been used by
 * three technicians this week holds three sets of records, and the moment
 * anybody signs out is the right moment for all of them to go. Keeping another
 * technician's jobs "because they might come back" is how one person's work
 * ends up on another person's screen.
 *
 * The transaction below names four stores and `pending` is not one of them, so
 * this cannot reach it even by accident.
 */
export const clearCachedJobs = async (): Promise<void> => {
  if (!isJobCacheSupported()) return;
  await withStores('readwrite', (jobs, meta, device, place) => {
    jobs.clear();
    meta.clear();
    // Including the pointer: a signed-out tablet does not know whose it was.
    device.clear();
    // And where anybody was. A job number is small, and it is still a fact
    // about a customer's work sitting on a device that has changed hands.
    place.clear();
  });
};

/**
 * Removes every record that is not this user's.
 *
 * For the sign-IN side of the same rule: whoever starts a shift gets a device
 * holding their own data and nothing from the last person, even if the last
 * session ended by the battery going flat rather than by signing out.
 */
export const clearOtherUsers = async (userId: string): Promise<void> => {
  if (!isJobCacheSupported() || userId.length === 0) return;
  await withStores('readwrite', async (jobs, meta, device, place) => {
    const keys = await request(jobs.getAllKeys());
    const records = await request<CachedJobRecord[]>(
      jobs.getAll() as IDBRequest<CachedJobRecord[]>,
    );
    records.forEach((record, index) => {
      if (record.userId !== userId) jobs.delete(keys[index]!);
    });

    const metas = await request<CacheMeta[]>(meta.getAll() as IDBRequest<CacheMeta[]>);
    for (const entry of metas) if (entry.userId !== userId) meta.delete(entry.userId);

    // And the device pointer, if it names somebody else. It is re-written by
    // the first authenticated read this session makes.
    const held = await request<DeviceSession | undefined>(
      device.get(DEVICE_KEY) as IDBRequest<DeviceSession | undefined>,
    );
    if (held !== undefined && held.userId !== userId) device.delete(DEVICE_KEY);

    const places = await request<LastPlace[]>(place.getAll() as IDBRequest<LastPlace[]>);
    for (const entry of places) if (entry.userId !== userId) place.delete(entry.userId);
  });
};
