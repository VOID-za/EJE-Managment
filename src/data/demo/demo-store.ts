import {
  clearPersistedDatabase,
  createSeededDatabase,
  loadDatabase,
  persistDatabase,
  type DemoDatabase,
} from './store';

/**
 * External mutable store for the demonstration dataset.
 *
 * Deliberately a plain class rather than React state. React subscribes through
 * `useSyncExternalStore`, which is the correct primitive for a store whose value
 * differs between the server render and the hydrated client (the server has the
 * seeded data; the browser may have persisted demo state). That keeps hydration
 * honest without any render-phase mutation or effect-driven state juggling.
 *
 * In Phase 2 this class disappears: the repositories talk to the REST API and a
 * real query cache handles invalidation.
 */
export class DemoStore {
  private database: DemoDatabase | null = null;
  private version = 0;
  private readonly listeners = new Set<() => void>();

  /** Lazily hydrates from browser storage on first access. */
  read = (): DemoDatabase => {
    if (this.database === null) {
      this.database = loadDatabase();
    }
    return this.database;
  };

  commit = (mutate: (draft: DemoDatabase) => void): void => {
    const draft = this.read();
    mutate(draft);
    persistDatabase(draft);
    this.version += 1;
    this.emit();
  };

  reset = (): void => {
    clearPersistedDatabase();
    this.database = createSeededDatabase();
    persistDatabase(this.database);
    this.version += 1;
    this.emit();
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Client snapshot: a monotonic version that changes on every write. */
  getVersion = (): number => this.version;

  /** Server snapshot: always zero, so the server render is deterministic. */
  getServerVersion = (): number => 0;

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }
}

const SESSION_KEY = 'eje.demo.session.v1';

/**
 * Signed-in user id, held outside React for the same hydration reason as the
 * dataset above. Replaced by a real session in Phase 2.
 */
export class SessionStore {
  private userId: string | null = null;
  private loaded = false;
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): string | null => {
    if (!this.loaded) {
      this.loaded = true;
      try {
        this.userId = window.localStorage.getItem(SESSION_KEY);
      } catch {
        this.userId = null;
      }
    }
    return this.userId;
  };

  getServerSnapshot = (): string | null => null;

  signIn = (userId: string): void => {
    this.userId = userId;
    this.loaded = true;
    try {
      window.localStorage.setItem(SESSION_KEY, userId);
    } catch {
      // Session persistence is a convenience only.
    }
    this.emit();
  };

  signOut = (): void => {
    this.userId = null;
    this.loaded = true;
    try {
      window.localStorage.removeItem(SESSION_KEY);
    } catch {
      // Nothing to do.
    }
    this.emit();
  };

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }
}
