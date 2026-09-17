import type { OutboxEntry, OutboxReader } from '../ports';

/**
 * Simulated outbox shared by the email and WhatsApp adapters.
 *
 * Nothing here leaves the browser. The Notifications screen reads this outbox
 * so a demo audience can see exactly what production *would* transmit.
 *
 * Entries are persisted to browser storage for the same reason the demo dataset
 * is: a demonstration must survive a page refresh. Production replaces this
 * entirely with provider delivery receipts.
 */
const STORAGE_KEY = 'eje.demo.outbox.v1';
const EMPTY: readonly OutboxEntry[] = [];

export class SimulatedOutbox implements OutboxReader {
  private entries: readonly OutboxEntry[] = EMPTY;
  private loaded = false;
  private readonly listeners = new Set<() => void>();

  record(entry: OutboxEntry): OutboxEntry {
    this.entries = [entry, ...this.read()];
    this.persist();
    this.listeners.forEach((listener) => listener());
    return entry;
  }

  list(): Promise<readonly OutboxEntry[]> {
    return Promise.resolve(this.read());
  }

  clear(): void {
    this.entries = EMPTY;
    this.loaded = true;
    this.persist();
    this.listeners.forEach((listener) => listener());
  }

  /** Stable snapshot for `useSyncExternalStore`. */
  listSync = (): readonly OutboxEntry[] => this.read();

  /** The server never has outbox entries. */
  listServer = (): readonly OutboxEntry[] => EMPTY;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private read(): readonly OutboxEntry[] {
    if (this.loaded) return this.entries;
    this.loaded = true;

    if (typeof window === 'undefined') return this.entries;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw !== null) this.entries = JSON.parse(raw) as readonly OutboxEntry[];
    } catch {
      // A corrupt outbox must never block the demo.
      this.entries = EMPTY;
    }
    return this.entries;
  }

  private persist(): void {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.entries));
    } catch {
      // Storage may be full or blocked; the demo continues in memory.
    }
  }
}
