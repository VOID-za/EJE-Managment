import {
  clearPersistedDatabase,
  createSeededDatabase,
  loadDatabase,
  persistDatabase,
  type DatabaseSource,
  type DemoDatabase,
  type SnapshotFailure,
  type SnapshotStorage,
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
/**
 * Raised when a change could not be written to storage.
 *
 * A distinct error type so the operation layer can propagate it and the screen
 * can say what actually happened, rather than the write failing invisibly and
 * the user being shown a success they did not get.
 */
export class SnapshotWriteError extends Error {
  constructor(readonly failure: SnapshotFailure) {
    super(failure.message);
    this.name = 'SnapshotWriteError';
  }
}

export class DemoStore {
  /**
   * Where the snapshot lives.
   *
   * Injectable so the failure paths can be driven by a test. Undefined means
   * "whatever `store.ts` finds", which in a browser is `localStorage` and on
   * the server is nothing at all.
   */
  constructor(private readonly storage?: SnapshotStorage) {}

  private database: DemoDatabase | null = null;
  private version = 0;
  private readonly listeners = new Set<() => void>();
  private source: DatabaseSource = 'seeded';
  private failure: SnapshotFailure | null = null;
  /**
   * Set when the stored snapshot could not be READ.
   *
   * Nothing is written while this holds. Overwriting data we could not
   * understand would destroy the only copy of it, and the user has been told
   * their data is still there — so it has to still be there.
   */
  private protectStoredSnapshot = false;

  /** Lazily hydrates from browser storage on first access. */
  read = (): DemoDatabase => {
    if (this.database === null) {
      const load = this.storage === undefined ? loadDatabase() : loadDatabase(this.storage);
      this.database = load.data;
      this.source = load.source;
      this.failure = load.failure;
      this.protectStoredSnapshot = load.protectStoredSnapshot;
    }
    return this.database;
  };

  /**
   * Applies a change, and REPORTS it if it could not be saved.
   *
   * The in-memory dataset is updated either way so the screen does not tear
   * itself apart mid-operation, but the caller is told by an exception that the
   * change did not reach storage. The operation layer turns that into the
   * ordinary "this could not be done" path, and the banner stays up until a
   * write succeeds — so nobody is told a capture was saved when it was not.
   */
  commit = (mutate: (draft: DemoDatabase) => void): void => {
    const draft = this.read();
    mutate(draft);

    if (this.protectStoredSnapshot) {
      this.version += 1;
      this.emit();
      throw new SnapshotWriteError({
        kind: 'write_failed',
        message:
          'This change was not saved. Saved demonstration data on this browser could not be read, and it is deliberately not being overwritten — reset the demonstration data to start a fresh one.',
        storedVersion: this.failure?.storedVersion ?? null,
      });
    }

    const result = this.persist(draft);
    this.version += 1;

    if (!result.ok) {
      this.failure = result.failure;
      this.emit();
      throw new SnapshotWriteError(result.failure);
    }

    // A write that succeeds clears a previous write failure: the storage is
    // working again and the banner should not linger.
    if (this.failure?.kind === 'write_failed') this.failure = null;
    this.emit();
  };

  reset = (): void => {
    if (this.storage === undefined) clearPersistedDatabase();
    else clearPersistedDatabase(this.storage);
    this.database = createSeededDatabase();
    this.source = 'seeded';
    this.protectStoredSnapshot = false;
    const result = this.persist(this.database);
    this.failure = result.ok ? null : result.failure;
    this.version += 1;
    this.emit();
  };

  private persist = (data: DemoDatabase) =>
    this.storage === undefined ? persistDatabase(data) : persistDatabase(data, this.storage);

  /** What went wrong with storage, if anything. Null when all is well. */
  getFailure = (): SnapshotFailure | null => {
    // Reading hydrates, which is what discovers a load failure in the first place.
    this.read();
    return this.failure;
  };

  /** Server snapshot: no storage was consulted, so nothing can have failed. */
  getServerFailure = (): SnapshotFailure | null => null;

  /** Where the working dataset came from. For the banner's wording. */
  getSource = (): DatabaseSource => {
    this.read();
    return this.source;
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
