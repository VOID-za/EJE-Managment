import type {
  ActivityEvent,
  AppNotification,
  Customer,
  Contact,
  Job,
  Machine,
  Site,
  SystemSettings,
} from '@/domain';
import {
  seedActivity,
  seedContacts,
  seedCustomers,
  seedJobs,
  seedMachines,
  seedNotifications,
  seedSettings,
  seedSites,
} from '../seed';

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
  activity: ActivityEvent[];
  notifications: AppNotification[];
  settings: SystemSettings;
  favouriteDocuments: Record<string, string[]>;
  recentDocuments: Record<string, string[]>;
}

export const STORAGE_KEY = 'eje.demo.database.v1';

/** Current shape version. A mismatch discards the persisted copy and re-seeds. */
export const SCHEMA_VERSION = 1;

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
  activity: seedActivity.map((entry) => ({ ...entry })),
  notifications: seedNotifications.map((notification) => ({ ...notification })),
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
    if (parsed.version !== SCHEMA_VERSION) return createSeededDatabase();
    return parsed.data;
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
