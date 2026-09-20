import type {
  ActivityEvent,
  AppNotification,
  ChecklistTemplate,
  Customer,
  Contact,
  Job,
  Machine,
  Site,
  AvailabilityRecord,
  SystemSettings,
  TechnicalDocument,
  ChatMessage,
  Conversation,
  User,
} from '@/domain';
import {
  seedActivity,
  seedChecklistTemplates,
  seedContacts,
  seedCustomers,
  seedDocuments,
  seedJobs,
  seedMachines,
  seedAvailability,
  seedConversations,
  seedChatMessages,
  seedNotifications,
  seedSettings,
  seedSites,
  seedUsers,
} from '../seed';
import { migrateDatabase, OLDEST_MIGRATABLE_VERSION } from './migrations';

/**
 * The demo's mutable dataset.
 *
 * It is a plain, serialisable snapshot. Reads and writes go through the
 * repositories in `../demo/repositories.ts`, never directly from the UI.
 *
 * Persistence note: the demo persists to `localStorage` so that a demonstration
 * survives a page refresh. That is a *demo-only* concern — in Phase 2 the same
 * repository interfaces are backed by PostgreSQL through the REST API, and this
 * module is deleted rather than rewritten.
 */
export interface DemoDatabase {
  jobs: Job[];
  customers: Customer[];
  sites: Site[];
  contacts: Contact[];
  machines: Machine[];
  // Users, documents and checklist templates are administered by Masters, so
  // they live in the mutable dataset rather than being read from the seed
  // constants. Phase 2 replaces this object with database tables.
  users: User[];
  documents: TechnicalDocument[];
  checklistTemplates: ChecklistTemplate[];
  activity: ActivityEvent[];
  notifications: AppNotification[];
  availability: AvailabilityRecord[];
  conversations: Conversation[];
  chatMessages: ChatMessage[];
  settings: SystemSettings;
  /**
   * Stored files, keyed by storage key — the demo's disk.
   *
   * Holds the bytes of a closed job's final document so a download returns the
   * exact file that was issued rather than rendering a new one. Base64 because
   * the snapshot is JSON in `localStorage`; Phase 2 replaces this with VPS disk
   * and then object storage, behind the same `StorageService` port.
   */
  files: Record<string, StoredFileRecord>;
  favouriteDocuments: Record<string, string[]>;
  recentDocuments: Record<string, string[]>;
}

export interface StoredFileRecord {
  readonly fileName: string;
  readonly contentType: string;
  readonly base64: string;
  /** See `StoredFileRecord` in `src/services/simulated/storage.ts`. */
  readonly renderer?: number;
  readonly backfilled?: boolean;
}

export const STORAGE_KEY = 'eje.demo.database.v1';

/**
 * Current shape version.
 *
 * Bump this whenever the stored shape changes, and add the matching step in
 * `./migrations` — otherwise a browser that has already run the demo keeps its
 * old snapshot and silently misses new fields.
 * v2 added technician leave and the service end date.
 * v3 added the Parts job type: a nullable machine and the courier flag.
 * v4 moved users, technical documents and checklist templates into the store so
 * Masters can administer them.
 * v5 replaced leave with availability records that carry times and authorship,
 * added technician messages, and gave jobs cancellation and soft deletion.
 * v6 turned one-way technician messages into two-way conversations, gave
 * notifications an explicit link, and stored the final document on a closed job.
 * v7 added `files`: the stored BYTES of a final document, so downloading a
 * closed job's job card returns the issued file instead of rendering one.
 * v8 discards those cached bytes: a browser that had downloaded a seeded job's
 * job card was being handed that first render for good, so renderer fixes never
 * reached it. Backfilled files now carry the renderer that made them.
 * v9 added the customer's office address, the customer's own machine number,
 * the delivery record a job carries while its copy is in transit, and the
 * archive marker on sites, contacts and machines.
 *
 * From v8 onwards a mismatch is MIGRATED rather than discarded — see
 * `./migrations`. Only a snapshot older than that is re-seeded, and only
 * because the shapes before it are no longer described anywhere.
 */
export const SCHEMA_VERSION = 12;

interface PersistedEnvelope {
  readonly version: number;
  readonly data: DemoDatabase;
}

export const createSeededDatabase = (): DemoDatabase => ({
  jobs: seedJobs.map((job) => ({ ...job })),
  customers: seedCustomers.map((customer) => ({ ...customer })),
  sites: seedSites.map((site) => ({ ...site })),
  contacts: seedContacts.map((contact) => ({ ...contact })),
  machines: seedMachines.map((machine) => ({ ...machine })),
  users: seedUsers.map((user) => ({ ...user })),
  documents: seedDocuments.map((document) => ({ ...document })),
  checklistTemplates: seedChecklistTemplates.map((template) => ({ ...template })),
  activity: seedActivity.map((entry) => ({ ...entry })),
  notifications: seedNotifications.map((notification) => ({ ...notification })),
  availability: seedAvailability.map((record) => ({ ...record })),
  // Empty: seeded closed jobs have their file written on first access, since a
  // seed cannot ship binary content. Jobs closed in a session get theirs at
  // the moment the Master issues them.
  files: {},
  conversations: seedConversations.map((conversation) => ({ ...conversation })),
  chatMessages: seedChatMessages.map((message) => ({ ...message })),
  settings: { ...seedSettings },
  favouriteDocuments: {
    'user-tech-sipho': ['doc-lw-v40-electrical', 'doc-fanuc-alarms'],
    'user-master-elmarie': ['doc-safety-general'],
  },
  recentDocuments: {
    'user-tech-sipho': ['doc-lw-v40-electrical', 'doc-lw-v40-manual', 'doc-safety-general'],
    'user-master-elmarie': ['doc-proc-installation'],
  },
});

const isBrowser = (): boolean => typeof window !== 'undefined';

/**
 * The part of `Storage` this module uses.
 *
 * An interface rather than `window.localStorage` directly, so the failure paths
 * below can be exercised by a test. Every one of them used to be a silent
 * `catch`, which is the only reason they were never noticed.
 */
export interface SnapshotStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const browserStorage = (): SnapshotStorage | null => {
  if (!isBrowser()) return null;
  try {
    return window.localStorage;
  } catch {
    // Blocked entirely, e.g. by site-data settings. Reported, not swallowed.
    return null;
  }
};

/**
 * Why saved data could not be read, or could not be written.
 *
 * A discriminated value rather than a thrown-away exception, because the person
 * using the system has to be told. A technician who captured a day's work and
 * refreshed the tablet must never be handed the seed data with no explanation,
 * and must never be told a capture was saved when it was not.
 */
export type SnapshotFailureKind =
  /** The stored JSON could not be parsed, or is not an envelope. */
  | 'unreadable'
  /** Older than the oldest shape any migration step still describes. */
  | 'unsupported_version'
  /** A migration step existed but threw on this snapshot. */
  | 'migration_failed'
  /** The write itself failed — storage full, blocked, or unavailable. */
  | 'write_failed';

export interface SnapshotFailure {
  readonly kind: SnapshotFailureKind;
  /** Said to the user, in their terms. */
  readonly message: string;
  /** The stored version, where it could be read. */
  readonly storedVersion: number | null;
}

/** Where the working dataset came from. */
export type DatabaseSource =
  /** Nothing was stored, or nothing could be read; this is the seed. */
  | 'seeded'
  /** The stored snapshot, already at the current shape. */
  | 'restored'
  /** The stored snapshot, brought forward by the migration chain. */
  | 'migrated';

export interface DatabaseLoad {
  readonly data: DemoDatabase;
  readonly source: DatabaseSource;
  /**
   * Set when a snapshot EXISTS but could not be used.
   *
   * `data` is then the seed, held in memory only. The stored snapshot is left
   * exactly as it is — see `protectStoredSnapshot` — so the demonstration can
   * carry on while nothing the user captured is destroyed, and a fix or an
   * export can still recover it.
   */
  readonly failure: SnapshotFailure | null;
  /**
   * True when the stored snapshot must not be written over.
   *
   * The whole point of not reseeding silently: if we cannot READ what is there,
   * we certainly must not overwrite it with something else.
   */
  readonly protectStoredSnapshot: boolean;
}

export type PersistResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: SnapshotFailure };

const failure = (
  kind: SnapshotFailureKind,
  message: string,
  storedVersion: number | null = null,
): SnapshotFailure => ({ kind, message, storedVersion });

const seeded = (): DatabaseLoad => ({
  data: createSeededDatabase(),
  source: 'seeded',
  failure: null,
  protectStoredSnapshot: false,
});

/**
 * Reads the stored snapshot, and says honestly what happened.
 *
 * It used to answer every problem — a corrupt file, a parse error, a snapshot
 * older than the migration chain — with `createSeededDatabase()`, which looks
 * identical to a first visit. A demonstration that had a week of captured work
 * in it came back as the seed with nothing said, and the next write then
 * overwrote the snapshot that might have been recoverable.
 *
 * Now every one of those paths returns a failure alongside seed data to keep
 * working with, and marks the stored snapshot as not-to-be-written.
 */
export const loadDatabase = (storage: SnapshotStorage | null = browserStorage()): DatabaseLoad => {
  if (storage === null) return seeded();

  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return {
      data: createSeededDatabase(),
      source: 'seeded',
      failure: failure(
        'unreadable',
        'Saved demonstration data could not be read from this browser. Nothing has been overwritten.',
      ),
      protectStoredSnapshot: true,
    };
  }

  // Genuinely nothing stored: a first visit, which is not a failure.
  if (raw === null) return seeded();

  let parsed: PersistedEnvelope;
  try {
    parsed = JSON.parse(raw) as PersistedEnvelope;
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.version !== 'number') {
      throw new Error('not an envelope');
    }
  } catch {
    return {
      data: createSeededDatabase(),
      source: 'seeded',
      failure: failure(
        'unreadable',
        'The saved demonstration data is damaged and could not be read. It has NOT been overwritten, and the demonstration is running on the seeded data instead.',
      ),
      protectStoredSnapshot: true,
    };
  }

  if (parsed.version === SCHEMA_VERSION) {
    return { data: parsed.data, source: 'restored', failure: null, protectStoredSnapshot: false };
  }

  // A newer snapshot than this build understands: an older build opened after a
  // newer one. Migrations only run forward, so this is read-only territory.
  if (parsed.version > SCHEMA_VERSION) {
    return {
      data: createSeededDatabase(),
      source: 'seeded',
      failure: failure(
        'unsupported_version',
        `The saved data was written by a newer version of this system (v${parsed.version}; this build understands v${SCHEMA_VERSION}). It has NOT been changed.`,
        parsed.version,
      ),
      protectStoredSnapshot: true,
    };
  }

  // An older snapshot is brought forward, not thrown away: the customers,
  // jobs and job cards captured in this browser are the demonstration.
  let migrated: DemoDatabase | null;
  try {
    migrated = migrateDatabase(parsed.version, parsed.data, SCHEMA_VERSION);
  } catch {
    return {
      data: createSeededDatabase(),
      source: 'seeded',
      failure: failure(
        'migration_failed',
        `The saved data (v${parsed.version}) could not be brought forward to this version. It has NOT been overwritten.`,
        parsed.version,
      ),
      protectStoredSnapshot: true,
    };
  }

  if (migrated === null) {
    /*
     * Two different problems, told apart because they mean different things to
     * whoever is holding the tablet: a snapshot from before the migration chain
     * begins is simply too old for this build, while anything else that refuses
     * to migrate is a fault. Neither is answered by overwriting it.
     */
    const tooOld = parsed.version < OLDEST_MIGRATABLE_VERSION;
    return {
      data: createSeededDatabase(),
      source: 'seeded',
      failure: failure(
        tooOld ? 'unsupported_version' : 'migration_failed',
        tooOld
          ? `The saved data is from v${parsed.version}, which this version can no longer read. It has NOT been overwritten.`
          : `The saved data (v${parsed.version}) could not be brought forward to this version. It has NOT been overwritten.`,
        parsed.version,
      ),
      protectStoredSnapshot: true,
    };
  }

  // The migration succeeded, so writing the brought-forward snapshot back is
  // safe. A write failure here is reported rather than swallowed.
  const written = persistDatabase(migrated, storage);
  return {
    data: migrated,
    source: 'migrated',
    failure: written.ok ? null : written.failure,
    protectStoredSnapshot: false,
  };
};

/**
 * Writes the snapshot, and says whether it actually went.
 *
 * Returns a result instead of swallowing the exception. A full or blocked
 * storage used to mean the demo "continued in memory" — which is a polite way
 * of saying the technician's work existed only until the next refresh, and
 * nothing anywhere said so.
 */
export const persistDatabase = (
  data: DemoDatabase,
  storage: SnapshotStorage | null = browserStorage(),
): PersistResult => {
  if (storage === null) {
    // No storage at all — the server render, or a browser with site data
    // blocked. Not a failure to report: there is nothing to lose.
    return { ok: true };
  }

  try {
    const envelope: PersistedEnvelope = { version: SCHEMA_VERSION, data };
    storage.setItem(STORAGE_KEY, JSON.stringify(envelope));
    return { ok: true };
  } catch {
    return {
      ok: false,
      failure: failure(
        'write_failed',
        'The last change could not be saved to this browser — its storage is full or blocked. Anything captured since then will be lost if this page is reloaded.',
      ),
    };
  }
};

export const clearPersistedDatabase = (storage: SnapshotStorage | null = browserStorage()): void => {
  if (storage === null) return;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do: removing a key that cannot be reached leaves nothing behind.
  }
};
