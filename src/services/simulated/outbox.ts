import type { DeliveryState, OutboxEntry, OutboxReader } from '../ports';

/**
 * Simulated outbox shared by the email and WhatsApp adapters.
 *
 * NOTHING HERE IS TRANSMITTED. The Notifications screen reads this outbox
 * through `GET /api/outbox` so an audience can see exactly what production
 * *would* send. Production replaces it entirely with provider delivery
 * receipts.
 *
 * It lives in the SERVER process, with the rest of the composition root. It
 * used to persist itself to browser storage, because it used to run in the
 * browser; the entries now last as long as the process does, which is stated
 * plainly rather than disguised — a restart loses them, the same as the issued
 * documents, and durable delivery records belong with the real integration.
 */
const EMPTY: readonly OutboxEntry[] = [];

export class SimulatedOutbox implements OutboxReader {
  private entries: readonly OutboxEntry[] = EMPTY;
  private readonly listeners = new Set<() => void>();

  record(entry: OutboxEntry): OutboxEntry {
    this.entries = [entry, ...this.entries];
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
    this.listeners.forEach((listener) => listener());
    return updated;
  }

  list(): Promise<readonly OutboxEntry[]> {
    return Promise.resolve(this.read());
  }

  clear(): void {
    this.entries = EMPTY;
    this.listeners.forEach((listener) => listener());
  }

  /** A synchronous snapshot, for the tests and for server code holding it. */
  listSync = (): readonly OutboxEntry[] => this.read();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private read(): readonly OutboxEntry[] {
    return this.entries;
  }
}
