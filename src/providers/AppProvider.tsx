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
import {
  clearCachedJobs,
  clearOtherUsers,
  clearUnconfirmedSignOut,
  markUnconfirmedSignOut,
  readUnconfirmedSignOut,
} from '@/lib/pwa/job-cache';

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
  /**
   * True when this device signed out with no signal and the server has not
   * been told yet. BD-16: the session is not adopted while this holds, and the
   * sign-in screen says why rather than looking like an ordinary sign-out.
   */
  readonly signOutPending: boolean;
  signIn(email: string, password: string): Promise<{ ok: boolean; message: string | null }>;
  signOut(): Promise<void>;
  /**
   * Takes on whichever session the browser now holds.
   *
   * For the development user switcher, which signs in on the SERVER and sends
   * back a new cookie. The identity is then whatever `/api/auth/me` says, the
   * same as on any other visit — the client is not told who it became, it asks.
   */
  adoptSession(): Promise<void>;
  /** Called by `useOperation` after a successful write. */
  invalidate(): void;
  reportConnectionError(message: string | null): void;
}

const AppContext = createContext<AppContextValue | null>(null);

/**
 * This device was signed out and the server has not been told yet. BD-16.
 *
 * A control-flow signal rather than a failure: it means "do not adopt the
 * session", and the sign-in screen is the correct outcome.
 */
class SignedOutOnThisDevice extends Error {
  /** False while the server still has not been told, which the screen says. */
  readonly delivered: boolean;

  constructor(delivered: boolean) {
    super('This tablet was signed out.');
    this.name = 'SignedOutOnThisDevice';
    this.delivered = delivered;
  }
}

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
  /** A sign-out this device made with no signal, still owed to the server. */
  const [signOutPending, setSignOutPending] = useState(false);

  /*
   * Who the server says we are. Asked once on mount; the cookie is what
   * carries the session across a reload, so there is nothing to restore from
   * storage.
   *
   * EXCEPT ONE THING. BD-16. A sign-out made with no signal could not revoke
   * the session, and the cookie this page cannot read is still valid — so the
   * device records that it was signed out, and this is where that record is
   * honoured: the session is NOT adopted, and the sign-out is finished as soon
   * as the server can be reached. Without it, a technician who handed the
   * tablet over after tapping Sign out in a basement was signed straight back
   * in on the next page load, and the next person had their identity.
   */
  useEffect(() => {
    let cancelled = false;
    const owed = readUnconfirmedSignOut().catch(() => null);

    owed
      .then(async (held) => {
        if (held === null) return auth.me();
        // Finish what the sign-out could not do. If it still cannot be
        // delivered the record stays and this device stays signed out.
        const delivered = await auth
          .signOut()
          .then(() => true)
          .catch(() => false);
        if (delivered) await clearUnconfirmedSignOut().catch(() => undefined);
        throw new SignedOutOnThisDevice(delivered);
      })
      .then((result) => {
        if (cancelled) return;
        setCurrentUser(toUser(result.user));
        setBackend(result.backend);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        /*
         * Not signed in is the ordinary case on a first visit, and is not an
         * error to report; anything else is a connection the person should
         * know about. A sign-out this device is still holding is neither — it
         * is a decision already taken, so the screen simply shows sign-in.
         */
        if (cause instanceof SignedOutOnThisDevice) {
          if (!cause.delivered) setSignOutPending(true);
          return;
        }
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
  useEffect(
    () =>
      onSessionEnded(() => {
        setCurrentUser(null);
        /*
         * A revoked session leaves nothing behind on the device. The cached
         * job list is the last signed-in technician's work for the day, and a
         * tablet is handed over between shifts — see `signOut`.
         */
        void clearCachedJobs().catch(() => undefined);
      }),
    [],
  );

  const signIn = useCallback(
    async (email: string, password: string) => {
      try {
        const result = await auth.signIn(email, password);
        setCurrentUser(toUser(result.user));
        setConnectionError(null);
        // The identity changed, so everything on screen is somebody else's.
        setVersion((current) => current + 1);
        /*
         * WHOEVER HAD THIS TABLET BEFORE DOES NOT KEEP A COPY. Their cached
         * jobs are removed on the way in as well as on the way out, because
         * sign-out is the one step a person in a hurry skips — the next
         * sign-in is the second chance to get this right.
         */
        void clearOtherUsers(result.user.id).catch(() => undefined);
        /*
         * A sign-in reached the server, so any sign-out this device was still
         * holding is moot: the previous session was replaced by this one.
         */
        void clearUnconfirmedSignOut().catch(() => undefined);
        setSignOutPending(false);
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
    const signedOutUser = currentUser;
    const delivered = await auth
      .signOut()
      .then(() => true)
      .catch(() => false);
    setCurrentUser(null);
    setVersion((current) => current + 1);
    /*
     * EVERY USER'S CACHE, NOT JUST THIS ONE'S. Signing out is the moment the
     * tablet stops belonging to anybody, and a store that still holds a job
     * list is customer and fault data sitting on a device about to change
     * hands. It is a cache of what the server already has, so there is nothing
     * of value to lose by emptying it.
     */
    await clearCachedJobs().catch(() => undefined);

    /*
     * THE SIGN-OUT THE SERVER NEVER HEARD. BD-16. Written after the cache is
     * emptied, because emptying it takes this store with it. While the record
     * is there the application will not adopt the session, and the next load
     * finishes the sign-out.
     */
    if (!delivered) {
      await markUnconfirmedSignOut(signedOutUser?.id ?? '').catch(() => undefined);
      setSignOutPending(true);
    }
  }, [currentUser]);

  const adoptSession = useCallback(async () => {
    const result = await auth.me();
    setCurrentUser(toUser(result.user));
    setBackend(result.backend);
    setConnectionError(null);
    // Somebody else is signed in now, so everything on screen is theirs.
    setVersion((current) => current + 1);
    // Including the cached copy — the switcher is a sign-in by another route.
    void clearOtherUsers(result.user.id).catch(() => undefined);
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
      signOutPending,
      signIn,
      signOut,
      adoptSession,
      invalidate,
      reportConnectionError,
    }),
    [
      currentUser,
      ready,
      backend,
      version,
      connectionError,
      signOutPending,
      signIn,
      signOut,
      adoptSession,
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
