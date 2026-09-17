'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { User, UserId } from '@/domain';
import { seedUsers } from '@/data/seed';
import { createDemoRepositories, type DemoContext } from '@/data/demo/repositories';
import {
  clearPersistedDatabase,
  createSeededDatabase,
  loadDatabase,
  persistDatabase,
  type DemoDatabase,
} from '@/data/demo/store';
import type { RepositoryBundle } from '@/data/repositories';
import { SimulatedEmailService } from '@/services/simulated/email';
import { SimulatedOutbox } from '@/services/simulated/outbox';
import { SimulatedPdfService } from '@/services/simulated/pdf';
import { SimulatedStorageService } from '@/services/simulated/storage';
import { SequentialIdGenerator, SystemClock } from '@/services/simulated/system';
import { SimulatedWhatsAppService } from '@/services/simulated/whatsapp';
import type { AppServices, OperationContext } from '@/application/context';
import type { OutboxEntry } from '@/services/ports';

/**
 * Application composition root.
 *
 * This is the only module that knows which concrete adapters are in use. Swapping
 * the demo adapters for production HTTP clients and real integrations is a change
 * here and nowhere else.
 */

const SESSION_KEY = 'eje.demo.session.v1';

interface AppContextValue {
  readonly repositories: RepositoryBundle;
  readonly services: AppServices;
  readonly currentUser: User | null;
  readonly users: readonly User[];
  /** Increments on every write so queries re-run. Replaced by cache invalidation in Phase 2. */
  readonly version: number;
  readonly outbox: readonly OutboxEntry[];
  signIn(userId: UserId): void;
  signOut(): void;
  resetDemoData(): void;
  /** Builds the context passed to application operations. */
  operationContext(): OperationContext;
}

const AppContext = createContext<AppContextValue | null>(null);

const readStoredSession = (): User | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (raw === null) return null;
    return seedUsers.find((user) => user.id === raw) ?? null;
  } catch {
    return null;
  }
};

export const AppProvider = ({ children }: { readonly children: ReactNode }) => {
  const databaseRef = useRef<DemoDatabase | null>(null);
  const [version, setVersion] = useState(0);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [outbox, setOutbox] = useState<readonly OutboxEntry[]>([]);

  // Hydration happens on the client only: the seeded snapshot must match on the
  // server render, then any persisted demo state is applied.
  if (!hydrated && typeof window !== 'undefined') {
    databaseRef.current = loadDatabase();
    setCurrentUser(readStoredSession());
    setHydrated(true);
  }
  if (databaseRef.current === null) {
    databaseRef.current = createSeededDatabase();
  }

  const demoContext = useMemo<DemoContext>(
    () => ({
      read: () => databaseRef.current ?? createSeededDatabase(),
      commit: (mutate) => {
        const draft = databaseRef.current ?? createSeededDatabase();
        mutate(draft);
        databaseRef.current = draft;
        persistDatabase(draft);
        setVersion((current) => current + 1);
      },
    }),
    [],
  );

  const repositories = useMemo(() => createDemoRepositories(demoContext), [demoContext]);

  const services = useMemo<AppServices & { outbox: SimulatedOutbox }>(() => {
    const clock = new SystemClock();
    const ids = new SequentialIdGenerator();
    const simulatedOutbox = new SimulatedOutbox();
    simulatedOutbox.subscribe(() => setOutbox(simulatedOutbox.listSync()));

    return {
      clock,
      ids,
      outbox: simulatedOutbox,
      email: new SimulatedEmailService(simulatedOutbox, clock, ids),
      whatsapp: new SimulatedWhatsAppService(simulatedOutbox, clock, ids),
      pdf: new SimulatedPdfService(clock),
      storage: new SimulatedStorageService(),
    };
  }, []);

  const signIn = useCallback((userId: UserId) => {
    const user = seedUsers.find((candidate) => candidate.id === userId) ?? null;
    setCurrentUser(user);
    try {
      if (user !== null) window.localStorage.setItem(SESSION_KEY, user.id);
    } catch {
      // Session persistence is a convenience only.
    }
  }, []);

  const signOut = useCallback(() => {
    setCurrentUser(null);
    try {
      window.localStorage.removeItem(SESSION_KEY);
    } catch {
      // Nothing to do.
    }
  }, []);

  const resetDemoData = useCallback(() => {
    clearPersistedDatabase();
    databaseRef.current = createSeededDatabase();
    persistDatabase(databaseRef.current);
    setVersion((current) => current + 1);
  }, []);

  const operationContext = useCallback((): OperationContext => {
    if (currentUser === null) {
      throw new Error('No user is signed in. Operations require an actor.');
    }
    return { repos: repositories, services, actor: currentUser };
  }, [currentUser, repositories, services]);

  const value = useMemo<AppContextValue>(
    () => ({
      repositories,
      services,
      currentUser,
      users: seedUsers,
      version,
      outbox,
      signIn,
      signOut,
      resetDemoData,
      operationContext,
    }),
    [
      repositories,
      services,
      currentUser,
      version,
      outbox,
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
