import 'server-only';
import type { RepositoryBundle } from '@/data/repositories';
import { selectPersistenceBackend, type PersistenceBackend } from '@/data/backend';
import { createDemoRepositories } from '@/data/demo/repositories';
import { DemoStore } from '@/data/demo/demo-store';
import { createPostgresRepositories } from '@/data/postgres';
import { withTransaction } from '@/data/postgres/transaction';
import { getDatabase } from '@/db/client';
import type { AppServices } from '@/application/context';
import { SimulatedEmailService } from '@/services/simulated/email';
import { SimulatedOutbox } from '@/services/simulated/outbox';
import { SimulatedPdfService } from '@/services/simulated/pdf';
import {
  inMemoryFileStore,
  DemoStorageService,
  type FileStore,
} from '@/services/simulated/storage';
import {
  FilesystemStorageService,
  readStorageConfiguration,
} from '@/services/production/file-storage';
import { SequentialIdGenerator, SystemClock } from '@/services/simulated/system';
import { SimulatedWhatsAppService } from '@/services/simulated/whatsapp';
import { UuidGenerator } from '@/services/production/ids';
import {
  CloudApiWhatsAppService,
  readWhatsAppConfiguration,
  UnconfiguredWhatsAppService,
} from '@/services/production/whatsapp';
import { DemoAuthStore } from './auth/demo-store';
import { PostgresAuthStore } from './auth/postgres-store';
import type { AuthStore } from './auth/store';
import {
  MemoryIdempotencyStore,
  PostgresIdempotencyStore,
  type IdempotencyStore,
} from './api/idempotency';

/**
 * The SERVER's composition root.
 *
 * One module decides what the application is actually running against, and it
 * decides from the server's environment. The browser has no vote: it sends an
 * authenticated HTTP request and is served whatever this built.
 *
 * `src/data/backend.ts` makes the choice; this assembles it. The choice is made
 * ONCE, at first use, and never reconsidered — in particular a PostgreSQL
 * backend that cannot reach its database raises, and does not quietly become
 * the demonstration store. A business being served fabricated data because a
 * connection dropped is the worst outcome available here.
 */
export interface UnitOfWork {
  readonly repos: RepositoryBundle;
  readonly services: AppServices;
  /**
   * Bound to the SAME transaction as the repositories.
   *
   * That is the whole mechanism: the record that a request was handled commits
   * with the change it recorded, or neither does.
   */
  readonly idempotency: IdempotencyStore;
}

export interface ServerRuntime {
  readonly backend: PersistenceBackend;
  readonly auth: AuthStore;
  /**
   * Runs work that WRITES.
   *
   * On PostgreSQL this opens a transaction and builds every repository on it,
   * so an operation that changes a job and appends an audit event either does
   * both or neither. The demonstration store has no transactions and says so.
   */
  write<T>(work: (unit: UnitOfWork) => Promise<T>): Promise<T>;
  /** Runs work that only reads. No transaction; one consistent row per statement. */
  read<T>(work: (unit: UnitOfWork) => Promise<T>): Promise<T>;
  /** The simulated outbox, where one exists. Never a production integration. */
  readonly outbox: SimulatedOutbox;
  /**
   * Returns the demonstration data to its seeded state.
   *
   * NULL ON POSTGRESQL, which is the point: there is no code path that can
   * discard a business's data, because on a real database the capability does
   * not exist to be called.
   */
  readonly resetDemoData: (() => void) | null;
}

interface BuiltServices {
  readonly services: AppServices;
  readonly outbox: SimulatedOutbox;
}

/**
 * Which WhatsApp this deployment actually has.
 *
 * THREE ANSWERS, and the third is the one that matters:
 *
 *  1. CONFIGURED — `WHATSAPP_PHONE_NUMBER_ID` and `WHATSAPP_ACCESS_TOKEN` are
 *     set, so messages go to Meta's Cloud API for real.
 *  2. THE DEMONSTRATION — no configuration and no database, so the simulated
 *     adapter records what would have been sent into the visible outbox. That
 *     is a demonstration telling the truth about itself.
 *  3. A REAL DEPLOYMENT WITH NO CONFIGURATION — PostgreSQL, no credentials.
 *     This REFUSES. It does not quietly fall back to the simulated adapter,
 *     because a business running on real data would then be shown an outbox
 *     full of messages nobody ever received.
 *
 * The refusal is not fatal to the work: the assignment notification catches it
 * and records on the audit trail that the message did not go, and why.
 */
const buildWhatsApp = (
  backend: PersistenceBackend,
  outbox: SimulatedOutbox,
  clock: SystemClock,
  ids: UuidGenerator | SequentialIdGenerator,
) => {
  const configured = readWhatsAppConfiguration();
  if (configured !== null) return new CloudApiWhatsAppService(configured, clock, ids);
  return backend === 'demo'
    ? new SimulatedWhatsAppService(outbox, clock, ids)
    : new UnconfiguredWhatsAppService();
};

const buildServices = (backend: PersistenceBackend, store: DemoStore | null): BuiltServices => {
  const clock = new SystemClock();
  /*
   * UUIDs against PostgreSQL, because every primary key is `uuid`. The
   * demonstration keeps its readable sequential ids, which is what makes its
   * seeded data legible on screen.
   */
  const ids = backend === 'postgres' ? new UuidGenerator() : new SequentialIdGenerator();
  const outbox = new SimulatedOutbox();

  /*
   * WHERE FILES ACTUALLY LIVE, and the two answers are not the same kind of
   * answer.
   *
   * POSTGRESQL GETS A DISK. `FilesystemStorageService` writes bytes to
   * `EJE_STORAGE_DIR` and reads them back, so a customer's order attached in
   * March is still there in September, across every restart in between. This
   * replaced an in-memory store that lost every issued job card when the
   * process ended — which was fine to say out loud and not fine to run a
   * business on.
   *
   * THE DEMONSTRATION GETS ITS SNAPSHOT, which survives a reload and not a
   * restart, and whose class says so in its own name. That is what keeps
   * `npm run dev` working end to end with nothing installed.
   */
  const files: FileStore =
    store === null
      ? inMemoryFileStore()
      : {
          get: (storageKey) => store.read().files[storageKey],
          set: (storageKey, record) => {
            store.commit((draft) => {
              draft.files[storageKey] = record;
            });
          },
        };

  const storage =
    backend === 'postgres'
      ? new FilesystemStorageService(readStorageConfiguration())
      : new DemoStorageService(files);

  const services: AppServices = {
    clock,
    ids,
    /*
     * Microsoft Graph and object storage are still simulated, deliberately and
     * visibly; WhatsApp is now real WHERE IT IS CONFIGURED — see
     * `buildWhatsApp`. Every one of them sits behind `src/services/ports.ts`
     * and is constructed here, so swapping an adapter is a change in this
     * function and nowhere else. That is what made the WhatsApp swap a
     * three-line change rather than a rewrite.
     */
    email: new SimulatedEmailService(outbox, clock, ids),
    whatsapp: buildWhatsApp(backend, outbox, clock, ids),
    pdf: new SimulatedPdfService(clock),
    storage,
  };

  return { services, outbox };
};

const createRuntime = (): ServerRuntime => {
  const backend = selectPersistenceBackend();

  if (backend === 'demo') {
    // One store for the process, so the demonstration has continuity between
    // requests the way a database would.
    const store = new DemoStore();
    const repos = createDemoRepositories({ read: store.read, commit: store.commit });
    const { services, outbox } = buildServices('demo', store);
    const unit: UnitOfWork = { repos, services, idempotency: new MemoryIdempotencyStore() };

    return {
      backend,
      auth: new DemoAuthStore(() => repos.users.list()),
      write: (work) => work(unit),
      read: (work) => work(unit),
      outbox,
      resetDemoData: () => {
        store.reset();
        outbox.clear();
      },
    };
  }

  const db = getDatabase();
  const { services, outbox } = buildServices('postgres', null);

  return {
    backend,
    auth: new PostgresAuthStore(db),
    write: (work) =>
      withTransaction(db, (tx) =>
        work({
          repos: createPostgresRepositories(tx),
          services,
          idempotency: new PostgresIdempotencyStore(tx),
        }),
      ),
    read: (work) =>
      work({
        repos: createPostgresRepositories(db),
        services,
        idempotency: new PostgresIdempotencyStore(db),
      }),
    outbox,
    resetDemoData: null,
  };
};

/**
 * The process-wide runtime.
 *
 * Cached on `globalThis` rather than in a module variable, because Next's
 * development server re-evaluates modules on edit and a fresh runtime per edit
 * would silently sign everybody out and reset the demonstration.
 */
const RUNTIME_KEY = Symbol.for('eje.server.runtime');

type RuntimeHolder = { [RUNTIME_KEY]?: ServerRuntime };

export const getServerRuntime = (): ServerRuntime => {
  const holder = globalThis as RuntimeHolder;
  holder[RUNTIME_KEY] ??= createRuntime();
  return holder[RUNTIME_KEY];
};

/** Drops the cached runtime. For tests, which build their own. */
export const resetServerRuntime = (): void => {
  delete (globalThis as RuntimeHolder)[RUNTIME_KEY];
};
