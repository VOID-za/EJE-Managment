import type { DeliveryState, OutboxEntry, OutboxReader } from '../ports';

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

  /**
   * Moves an entry to a new delivery state.
   *
   * This stands in for the delivery report a real provider sends back — a Graph
   * message trace, or a webhook. In the demonstration it is driven from the
   * Simulated Outbox screen, which is the only honest way to show a delivery
   * that the demo cannot actually observe: nothing here invents a confirmation
   * on its own.
   */
  setDelivery(id: string, delivery: DeliveryState, failureReason = ''): OutboxEntry | null {
    let updated: OutboxEntry | null = null;
    this.entries = this.read().map((entry) => {
      if (entry.id !== id) return entry;
      updated = { ...entry, delivery, failureReason };
      return updated;
    });
    if (updated === null) return null;
    this.persist();
    this.listeners.forEach((listener) => listener());
    return updated;
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
      if (raw !== null) {
        const parsed = JSON.parse(raw) as readonly OutboxEntry[];
        // Entries written before delivery was tracked carry no state. They are
        // read as pending, never as delivered: an old record is not evidence
        // that anything arrived.
        this.entries = parsed.map((entry) => ({
          ...entry,
          delivery: entry.delivery ?? 'pending_delivery',
          failureReason: entry.failureReason ?? '',
        }));
      }
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
