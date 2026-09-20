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
import { migrateDatabase } from './migrations';

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
export const SCHEMA_VERSION = 11;

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

export const loadDatabase = (): DemoDatabase => {
  if (!isBrowser()) return createSeededDatabase();

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return createSeededDatabase();

    const parsed = JSON.parse(raw) as PersistedEnvelope;
    if (parsed.version === SCHEMA_VERSION) return parsed.data;

    // An older snapshot is brought forward, not thrown away: the customers,
    // jobs and job cards captured in this browser are the demonstration.
    const migrated = migrateDatabase(parsed.version, parsed.data, SCHEMA_VERSION);
    if (migrated === null) return createSeededDatabase();
    persistDatabase(migrated);
    return migrated;
  } catch {
    // A corrupt or unreadable snapshot must never block the demo.
    return createSeededDatabase();
  }
};

export const persistDatabase = (data: DemoDatabase): void => {
  if (!isBrowser()) return;
  try {
    const envelope: PersistedEnvelope = { version: SCHEMA_VERSION, data };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // Storage may be full or blocked. The demo continues in memory.
  }
};

export const clearPersistedDatabase = (): void => {
  if (!isBrowser()) return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do.
  }
};
