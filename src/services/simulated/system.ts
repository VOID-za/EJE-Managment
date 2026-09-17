import type { Clock, IdGenerator } from '../ports';

export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}

/**
 * Monotonic id generator. Deterministic within a session, which keeps React
 * keys stable and avoids pulling in a uuid dependency for the demo.
 */
export class SequentialIdGenerator implements IdGenerator {
  private counters = new Map<string, number>();

  next(prefix: string): string {
    const current = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, current);
    return `${prefix}-${Date.now().toString(36)}-${current.toString(36)}`;
  }
}
