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
  SimulatedStorageService,
  type FileStore,
} from '@/services/simulated/storage';
import { SequentialIdGenerator, SystemClock } from '@/services/simulated/system';
import { SimulatedWhatsAppService } from '@/services/simulated/whatsapp';
import { UuidGenerator } from '@/services/production/ids';
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
   * Where an issued document's bytes live.
   *
   * The demonstration keeps them in its own snapshot, so a closed job's final
   * document survives a reload the way the rest of its data does. PostgreSQL
   * keeps them in process memory for now — production object storage is its own
   * phase, and pretending otherwise would be worse than saying so.
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

  const services: AppServices = {
    clock,
    ids,
    /*
     * STILL SIMULATED, deliberately and visibly.
     *
     * Microsoft Graph, WhatsApp Business and object storage are each their own
     * phase. What matters here is that they are behind `src/services/ports.ts`
     * and are now constructed on the SERVER, so the adapter swap is a change in
     * this function and nowhere else.
     */
    email: new SimulatedEmailService(outbox, clock, ids),
    whatsapp: new SimulatedWhatsAppService(outbox, clock, ids),
    pdf: new SimulatedPdfService(clock),
    storage: new SimulatedStorageService(files),
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
