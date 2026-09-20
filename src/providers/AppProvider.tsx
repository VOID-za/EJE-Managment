'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { User, UserId, UserRole } from '@/domain';
import { auth, type SafeUser } from '@/api/endpoints';
import { ApiRequestError, onSessionEnded } from '@/api/client';

/**
 * The browser's state, which is now almost none of it.
 *
 * WHAT THIS FILE USED TO BE: the composition root. It built the demonstration
 * repositories, the simulated services and an `OperationContext`, and handed
 * them to every screen — so the business logic ran in the browser and the
 * browser decided who was performing it.
 *
 * WHAT IT IS NOW: a session. It asks the server who is signed in, keeps the
 * answer, and counts writes so queries know to re-run. It holds no repository,
 * no service, no operation context and no user id it chose for itself. There is
 * no path from here to PostgreSQL, and there cannot be — the client bundle
 * contains neither a driver nor a connection string.
 *
 * `signIn` posts an email and a password. The SERVER decides whether that is
 * anybody, and what role they have; the identity below is whatever it said.
 */
export type PersistenceBackend = 'postgres' | 'demo';

interface AppContextValue {
  readonly currentUser: User | null;
  /** Null until the first `/api/auth/me` has answered. */
  readonly ready: boolean;
  /**
   * Which store is behind the API.
   *
   * Surfaced so the application can SAY when it is running the demonstration
   * data rather than the business's. A demonstration that looks identical to
   * production is how somebody captures a real job card into nothing.
   */
  readonly backend: PersistenceBackend | null;
  /** Bumped on every write so `useQuery` re-runs. */
  readonly version: number;
  /** Set when the last request could not reach the server. */
  readonly connectionError: string | null;
  signIn(email: string, password: string): Promise<{ ok: boolean; message: string | null }>;
  signOut(): Promise<void>;
  /** Called by `useOperation` after a successful write. */
  invalidate(): void;
  reportConnectionError(message: string | null): void;
}

const AppContext = createContext<AppContextValue | null>(null);

/** The API's safe projection is exactly the domain `User` minus nothing it needs. */
const toUser = (safe: SafeUser): User => ({
  id: safe.id as UserId,
  firstName: safe.firstName,
  lastName: safe.lastName,
  initials: safe.initials,
  email: safe.email,
  mobile: safe.mobile,
  role: safe.role as UserRole,
  jobTitle: safe.jobTitle,
  active: safe.active,
  createdAt: safe.createdAt,
});

export const AppProvider = ({ children }: { readonly children: ReactNode }) => {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [backend, setBackend] = useState<PersistenceBackend | null>(null);
  const [ready, setReady] = useState(false);
  const [version, setVersion] = useState(0);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // Who the server says we are. Asked once on mount; the cookie is what carries
  // the session across a reload, so there is nothing to restore from storage.
  useEffect(() => {
    let cancelled = false;
    auth
      .me()
      .then((result) => {
        if (cancelled) return;
        setCurrentUser(toUser(result.user));
        setBackend(result.backend);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        // Not signed in is the ordinary case on a first visit, and is not an
        // error to report; anything else is a connection the person should know
        // about.
        if (cause instanceof ApiRequestError && cause.code === 'network') {
          setConnectionError(cause.message);
        }
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /*
   * The server ending the session ends it here too.
   *
   * Any request may be the one that discovers a revoked session — a disabled
   * account, a logout elsewhere, an expiry. The client hears about it once,
   * centrally, rather than every screen having to check.
   */
  useEffect(() => onSessionEnded(() => setCurrentUser(null)), []);

  const signIn = useCallback(
    async (email: string, password: string) => {
      try {
        const result = await auth.signIn(email, password);
        setCurrentUser(toUser(result.user));
        setConnectionError(null);
        // The identity changed, so everything on screen is somebody else's.
        setVersion((current) => current + 1);
        const me = await auth.me().catch(() => null);
        if (me !== null) setBackend(me.backend);
        return { ok: true, message: null };
      } catch (cause) {
        const message =
          cause instanceof ApiRequestError
            ? cause.message
            : 'The sign-in could not be completed.';
        return { ok: false, message };
      }
    },
    [],
  );

  const signOut = useCallback(async () => {
    // Told to the server first, so the session is revoked rather than merely
    // forgotten by this browser.
    await auth.signOut().catch(() => undefined);
    setCurrentUser(null);
    setVersion((current) => current + 1);
  }, []);

  const invalidate = useCallback(() => setVersion((current) => current + 1), []);
  const reportConnectionError = useCallback(
    (message: string | null) => setConnectionError(message),
    [],
  );

  const value = useMemo<AppContextValue>(
    () => ({
      currentUser,
      ready,
      backend,
      version,
      connectionError,
      signIn,
      signOut,
      invalidate,
      reportConnectionError,
    }),
    [
      currentUser,
      ready,
      backend,
      version,
      connectionError,
      signIn,
      signOut,
      invalidate,
      reportConnectionError,
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
