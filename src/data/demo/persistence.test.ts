import { describe, expect, it } from 'vitest';
import {
  STORAGE_KEY,
  SCHEMA_VERSION,
  loadDatabase,
  persistDatabase,
  createSeededDatabase,
  type SnapshotStorage,
} from './store';
import { DemoStore, SnapshotWriteError } from './demo-store';

/**
 * Saved work is never thrown away without saying so.
 *
 * The behaviour these hold against was four silent `catch` blocks. An
 * unreadable snapshot, a snapshot older than the migration chain, a migration
 * that threw, and a failed write all resolved to the same thing: carry on with
 * the seeded data, say nothing. On a tablet that is a technician capturing a
 * day of work, seeing every screen confirm it, and losing all of it on the next
 * refresh — with the original snapshot overwritten by then, so there was
 * nothing left to recover either.
 *
 * Two properties are asserted everywhere below, because both matter and they
 * are not the same:
 *
 *   1. The user is told. A failure comes back as a value, not as silence.
 *   2. The stored snapshot is NOT overwritten. If we could not read it, we
 *      certainly must not replace it.
 */

/** A `localStorage` stand-in whose behaviour a test can choose. */
const fakeStorage = (
  initial: Record<string, string> = {},
  behaviour: { readonly failWrites?: boolean; readonly failReads?: boolean } = {},
): SnapshotStorage & { readonly items: Record<string, string> } => {
  const items: Record<string, string> = { ...initial };
  return {
    items,
    getItem: (key) => {
      if (behaviour.failReads === true) throw new Error('storage is blocked');
      return items[key] ?? null;
    },
    setItem: (key, value) => {
      // What a full quota actually does: a DOMException from `setItem`.
      if (behaviour.failWrites === true) throw new Error('QuotaExceededError');
      items[key] = value;
    },
    removeItem: (key) => {
      delete items[key];
    },
  };
};

const envelope = (version: number, data: unknown): string =>
  JSON.stringify({ version, data });

describe('reading a snapshot that cannot be used', () => {
  it('reports damaged data instead of pretending it is a first visit', () => {
    const storage = fakeStorage({ [STORAGE_KEY]: '{ this is not json' });
    const before = storage.items[STORAGE_KEY];

    const load = loadDatabase(storage);

    expect(load.failure?.kind).toBe('unreadable');
    expect(load.failure?.message).toMatch(/damaged/i);
    expect(load.failure?.message).toMatch(/NOT been overwritten/i);
    expect(load.protectStoredSnapshot).toBe(true);
    // The damaged snapshot is still exactly where it was.
    expect(storage.items[STORAGE_KEY]).toBe(before);
  });

  it('reports a snapshot older than any migration step still describes', () => {
    // v7 is below `OLDEST_MIGRATABLE_VERSION`, so nothing can bring it forward.
    const stored = envelope(7, { jobs: [{ jobNumber: 'EJE-9001' }] });
    const storage = fakeStorage({ [STORAGE_KEY]: stored });

    const load = loadDatabase(storage);

    expect(load.failure?.kind).toBe('unsupported_version');
    expect(load.failure?.storedVersion).toBe(7);
    expect(load.protectStoredSnapshot).toBe(true);
    expect(storage.items[STORAGE_KEY]).toBe(stored);
  });

  it('reports a snapshot written by a NEWER build, rather than replacing it', () => {
    const stored = envelope(SCHEMA_VERSION + 1, createSeededDatabase());
    const storage = fakeStorage({ [STORAGE_KEY]: stored });

    const load = loadDatabase(storage);

    expect(load.failure?.kind).toBe('unsupported_version');
    expect(load.failure?.storedVersion).toBe(SCHEMA_VERSION + 1);
    expect(load.protectStoredSnapshot).toBe(true);
    expect(storage.items[STORAGE_KEY]).toBe(stored);
  });

  it('reports a migratable version whose contents will not migrate', () => {
    // v8 is within the chain, but the payload is not a database at all, so the
    // chain cannot bring it forward. That is a fault, not an old snapshot.
    const stored = envelope(8, 'this is not a database');
    const storage = fakeStorage({ [STORAGE_KEY]: stored });

    const load = loadDatabase(storage);

    expect(load.failure?.kind).toBe('migration_failed');
    expect(load.failure?.storedVersion).toBe(8);
    expect(load.protectStoredSnapshot).toBe(true);
    expect(storage.items[STORAGE_KEY]).toBe(stored);
  });

  it('reports a migration step that threw, and leaves the snapshot alone', () => {
    // A null row inside `jobs` makes the v11 step throw while destructuring it.
    const stored = envelope(11, { jobs: [null] });
    const storage = fakeStorage({ [STORAGE_KEY]: stored });

    const load = loadDatabase(storage);

    expect(load.failure?.kind).toBe('migration_failed');
    expect(load.failure?.storedVersion).toBe(11);
    expect(load.protectStoredSnapshot).toBe(true);
    expect(storage.items[STORAGE_KEY]).toBe(stored);
  });

  it('reports storage that cannot be read at all', () => {
    const storage = fakeStorage({}, { failReads: true });
    const load = loadDatabase(storage);

    expect(load.failure?.kind).toBe('unreadable');
    expect(load.protectStoredSnapshot).toBe(true);
  });

  it('treats genuinely empty storage as the first visit it is', () => {
    const load = loadDatabase(fakeStorage());

    expect(load.failure).toBeNull();
    expect(load.source).toBe('seeded');
    expect(load.protectStoredSnapshot).toBe(false);
  });

  it('restores a current snapshot untouched', () => {
    const data = createSeededDatabase();
    data.settings = { ...data.settings, companyName: 'Restored From Storage' };
    const storage = fakeStorage({ [STORAGE_KEY]: envelope(SCHEMA_VERSION, data) });

    const load = loadDatabase(storage);

    expect(load.source).toBe('restored');
    expect(load.failure).toBeNull();
    expect(load.data.settings.companyName).toBe('Restored From Storage');
  });
});

describe('writing a snapshot that cannot be saved', () => {
  it('says so instead of swallowing the exception', () => {
    const storage = fakeStorage({}, { failWrites: true });

    const result = persistDatabase(createSeededDatabase(), storage);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failure.kind).toBe('write_failed');
    expect(result.ok === false && result.failure.message).toMatch(/could not be saved/i);
  });

  it('succeeds quietly when there is nowhere to write, which loses nothing', () => {
    // The server render. There is no storage and no data to lose, so this is
    // not a failure to put in front of anybody.
    expect(persistDatabase(createSeededDatabase(), null)).toEqual({ ok: true });
  });
});

describe('the store the application actually uses', () => {
  it('refuses to claim a change was saved when the write failed', () => {
    const storage = fakeStorage({}, { failWrites: true });
    const store = new DemoStore(storage);

    let thrown: unknown = null;
    try {
      store.commit((draft) => {
        draft.settings = { ...draft.settings, companyName: 'Changed' };
      });
    } catch (error) {
      thrown = error;
    }

    // The caller is told, so the operation layer can report the failure rather
    // than the screen confirming something that did not happen.
    expect(thrown).toBeInstanceOf(SnapshotWriteError);
    expect(store.getFailure()?.kind).toBe('write_failed');
    // Nothing was written.
    expect(storage.items[STORAGE_KEY]).toBeUndefined();
  });

  it('writes, and reports nothing, when storage is working', () => {
    const storage = fakeStorage();
    const store = new DemoStore(storage);

    store.commit((draft) => {
      draft.settings = { ...draft.settings, companyName: 'Saved Properly' };
    });

    expect(store.getFailure()).toBeNull();
    expect(storage.items[STORAGE_KEY]).toContain('Saved Properly');
  });

  it('never overwrites a snapshot it could not read', () => {
    const stored = '{ this is not json';
    const storage = fakeStorage({ [STORAGE_KEY]: stored });
    const store = new DemoStore(storage);

    // The load is reported...
    expect(store.getFailure()?.kind).toBe('unreadable');

    // ...and every write is refused rather than destroying the only copy.
    expect(() =>
      store.commit((draft) => {
        draft.settings = { ...draft.settings, companyName: 'Should never be written' };
      }),
    ).toThrow(SnapshotWriteError);

    expect(storage.items[STORAGE_KEY]).toBe(stored);
  });

  it('starts a fresh demonstration only when asked to, and then saves again', () => {
    const storage = fakeStorage({ [STORAGE_KEY]: '{ this is not json' });
    const store = new DemoStore(storage);
    expect(store.getFailure()).not.toBeNull();

    // Resetting IS the explicit consent that reseeding never had.
    store.reset();

    expect(store.getFailure()).toBeNull();
    expect(storage.items[STORAGE_KEY]).toContain('"version"');
    expect(() =>
      store.commit((draft) => {
        draft.settings = { ...draft.settings, companyName: 'Fresh' };
      }),
    ).not.toThrow();
    expect(storage.items[STORAGE_KEY]).toContain('Fresh');
  });
});

describe('what the user is told', () => {
  const messages = [
    loadDatabase(fakeStorage({ [STORAGE_KEY]: '{ broken' })).failure,
    loadDatabase(fakeStorage({ [STORAGE_KEY]: envelope(7, {}) })).failure,
    persistDatabase(createSeededDatabase(), fakeStorage({}, { failWrites: true })),
  ];

  it('never uses the word "reset" as though it had already happened', () => {
    for (const failure of messages) {
      const text = failure === null ? '' : JSON.stringify(failure);
      expect(text).not.toMatch(/has been reset/i);
      expect(text).not.toMatch(/data was cleared/i);
    }
  });

  it('says the stored data is intact, wherever that is the case', () => {
    const damaged = loadDatabase(fakeStorage({ [STORAGE_KEY]: '{ broken' }));
    const tooOld = loadDatabase(fakeStorage({ [STORAGE_KEY]: envelope(7, {}) }));

    for (const load of [damaged, tooOld]) {
      expect(load.failure?.message).toMatch(/NOT been (overwritten|changed)/i);
    }
  });
});
