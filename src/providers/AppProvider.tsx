'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { User, UserId } from '@/domain';
import { createDemoRepositories } from '@/data/demo/repositories';
import { DemoStore, SessionStore } from '@/data/demo/demo-store';
import type { RepositoryBundle } from '@/data/repositories';
import { SimulatedEmailService } from '@/services/simulated/email';
import { SimulatedOutbox } from '@/services/simulated/outbox';
import { SimulatedPdfService } from '@/services/simulated/pdf';
import { SimulatedStorageService } from '@/services/simulated/storage';
import { SequentialIdGenerator, SystemClock } from '@/services/simulated/system';
import { SimulatedWhatsAppService } from '@/services/simulated/whatsapp';
import type { AppServices, OperationContext } from '@/application/context';
import type { DeliveryState, OutboxEntry } from '@/services/ports';

/**
 * Application composition root.
 *
 * This is the only module that knows which concrete adapters are in use.
 * Swapping the demo adapters for production HTTP clients and real integrations
 * is a change here and nowhere else.
 */
interface AppContextValue {
  readonly repositories: RepositoryBundle;
  readonly services: AppServices;
  readonly currentUser: User | null;
  readonly users: readonly User[];
  /** Changes on every write so queries re-run. Becomes cache invalidation in Phase 2. */
  readonly version: number;
  readonly outbox: readonly OutboxEntry[];
  /**
   * Records what the provider would have reported about a message it accepted.
   *
   * Demo-only, and deliberately narrow: production learns this from the
   * provider's delivery report rather than from anybody pressing a button. It
   * is exposed so the Simulated Outbox screen can stand in for that report
   * without the rest of the application knowing which adapter is behind it.
   */
  reportDelivery(messageId: string, state: DeliveryState, failureReason?: string): void;
  signIn(userId: UserId): void;
  signOut(): void;
  resetDemoData(): void;
  /** Builds the context passed to application operations. */
  operationContext(): OperationContext;
}

const AppContext = createContext<AppContextValue | null>(null);

interface Runtime {
  readonly store: DemoStore;
  readonly session: SessionStore;
  readonly repositories: RepositoryBundle;
  readonly services: AppServices;
  readonly simulatedOutbox: SimulatedOutbox;
}

const createRuntime = (): Runtime => {
  const store = new DemoStore();
  const session = new SessionStore();
  const clock = new SystemClock();
  const ids = new SequentialIdGenerator();
  const simulatedOutbox = new SimulatedOutbox();

  return {
    store,
    session,
    simulatedOutbox,
    repositories: createDemoRepositories({ read: store.read, commit: store.commit }),
    services: {
      clock,
      ids,
      email: new SimulatedEmailService(simulatedOutbox, clock, ids),
      whatsapp: new SimulatedWhatsAppService(simulatedOutbox, clock, ids),
      pdf: new SimulatedPdfService(clock),
      // The demo's disk: a closed job's final document is kept in the persisted
      // snapshot, so a download hands back the file that was issued.
      storage: new SimulatedStorageService({
        get: (storageKey) => store.read().files[storageKey],
        set: (storageKey, record) => {
          store.commit((draft) => {
            draft.files[storageKey] = record;
          });
        },
      }),
    },
  };
};

export const AppProvider = ({ children }: { readonly children: ReactNode }) => {
  // Created once per mount. The runtime owns all mutable state; React only
  // subscribes to it.
  const [runtime] = useState(createRuntime);

  const version = useSyncExternalStore(
    runtime.store.subscribe,
    runtime.store.getVersion,
    runtime.store.getServerVersion,
  );

  const currentUserId = useSyncExternalStore(
    runtime.session.subscribe,
    runtime.session.getSnapshot,
    runtime.session.getServerSnapshot,
  );

  const outbox = useSyncExternalStore(
    runtime.simulatedOutbox.subscribe,
    runtime.simulatedOutbox.listSync,
    runtime.simulatedOutbox.listServer,
  );

  // Users are administered, so they come from the store rather than the seed
  // constants: a user a Master adds can sign in, and a rename shows up at once.
  const users = useMemo(() => {
    // `version` is the store's write counter. Reading it here is what makes this
    // re-run after a write — the lint rule cannot see that through `store.read`.
    void version;
    return runtime.store.read().users;
  }, [runtime.store, version]);

  const currentUser = useMemo(
    () => users.find((user) => user.id === currentUserId) ?? null,
    [users, currentUserId],
  );

  const reportDelivery = useCallback(
    (messageId: string, state: DeliveryState, failureReason = '') => {
      runtime.simulatedOutbox.setDelivery(messageId, state, failureReason);
    },
    [runtime.simulatedOutbox],
  );

  const signIn = useCallback(
    (userId: UserId) => runtime.session.signIn(userId),
    [runtime.session],
  );
  const signOut = useCallback(() => runtime.session.signOut(), [runtime.session]);
  const resetDemoData = useCallback(() => {
    runtime.store.reset();
    runtime.simulatedOutbox.clear();
  }, [runtime.store, runtime.simulatedOutbox]);

  const operationContext = useCallback((): OperationContext => {
    if (currentUser === null) {
      throw new Error('No user is signed in. Operations require an actor.');
    }
    return { repos: runtime.repositories, services: runtime.services, actor: currentUser };
  }, [currentUser, runtime.repositories, runtime.services]);

  const value = useMemo<AppContextValue>(
    () => ({
      repositories: runtime.repositories,
      services: runtime.services,
      currentUser,
      users,
      version,
      outbox,
      reportDelivery,
      signIn,
      signOut,
      resetDemoData,
      operationContext,
    }),
    [
      runtime.repositories,
      runtime.services,
      currentUser,
      users,
      version,
      outbox,
      reportDelivery,
      signIn,
      signOut,
      resetDemoData,
      operationContext,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};

export const useApp = (): AppContextValue => {
  const context = useContext(AppContext);
  if (context === null) {
    throw new Error('useApp must be used inside AppProvider.');
  }
  return context;
};

/** Convenience accessor for screens that require an authenticated user. */
export const useCurrentUser = (): User => {
  const { currentUser } = useApp();
  if (currentUser === null) {
    throw new Error('This screen requires a signed-in user.');
  }
  return currentUser;
};
