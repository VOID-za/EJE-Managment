import type { OutboxEntry, OutboxReader } from '../ports';

/**
 * In-memory simulated outbox shared by the email and WhatsApp adapters.
 *
 * Nothing here leaves the browser. The Notifications screen reads this outbox
 * so a demo audience can see exactly what production *would* transmit.
 */
export class SimulatedOutbox implements OutboxReader {
  private entries: OutboxEntry[] = [];
  private listeners = new Set<() => void>();

  record(entry: OutboxEntry): OutboxEntry {
    this.entries = [entry, ...this.entries];
    this.listeners.forEach((listener) => listener());
    return entry;
  }

  list(): Promise<readonly OutboxEntry[]> {
    return Promise.resolve(this.entries);
  }

  listSync(): readonly OutboxEntry[] {
    return this.entries;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
