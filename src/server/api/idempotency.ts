import 'server-only';
import { createHash } from 'node:crypto';
import { and, eq, lt, sql } from 'drizzle-orm';
import type { UserId } from '@/domain';
import type { DatabaseExecutor } from '@/db/client';
import * as schema from '@/db/schema';
import { ApiError } from './errors';

/**
 * Making a retry safe.
 *
 * The rule the whole mechanism rests on: THE MARKER AND THE WORK COMMIT
 * TOGETHER. On PostgreSQL both happen inside the request's transaction, so a
 * failure rolls the marker back with the change it was recording — a key that
 * marked an operation which then failed would permanently prevent it from ever
 * being retried, which is worse than doing it twice.
 *
 * A second request presenting the same key while the first is still in flight
 * blocks on the unique index until the first commits, and then sees it.
 */
export interface IdempotencyOutcome<T> {
  readonly replayed: boolean;
  readonly value: T;
}

export interface IdempotencyStore {
  /**
   * Claims the key, or returns what the first request answered.
   *
   * Returns null when this caller now owns the key and must do the work.
   */
  claim(scope: IdempotencyScope, requestHash: string): Promise<unknown | null>;
  complete(scope: IdempotencyScope, response: unknown): Promise<void>;
  /**
   * Releases a claim whose work failed.
   *
   * Only the in-memory store implements it. PostgreSQL gets the same effect for
   * free, because the marker is written inside the request's transaction and is
   * rolled back with the change it was recording.
   */
  release?(scope: IdempotencyScope): void;
}

export interface IdempotencyScope {
  readonly userId: UserId;
  readonly operation: string;
  readonly key: string;
}

/** The body this key was first used with, so reuse with a different one is caught. */
export const hashRequest = (body: unknown): string =>
  createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');

const REUSED_WITH_DIFFERENT_BODY = new ApiError(
  'conflict',
  'This request was already made with different details. Use a new request.',
  [
    {
      code: 'idempotency_key_reused',
      message: 'An Idempotency-Key may only ever be used for one request.',
    },
  ],
);

/** Still running somewhere else. The client should wait rather than duplicate it. */
const IN_FLIGHT = new ApiError(
  'conflict',
  'That request is already being processed. Wait a moment before retrying.',
  [{ code: 'request_in_flight', message: 'The first attempt has not finished yet.' }],
);

export class PostgresIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: DatabaseExecutor) {}

  async claim(scope: IdempotencyScope, requestHash: string): Promise<unknown | null> {
    const inserted = await this.db
      .insert(schema.apiIdempotency)
      .values({
        id: crypto.randomUUID(),
        userId: scope.userId,
        operation: scope.operation,
        idempotencyKey: scope.key,
        requestHash,
      })
      .onConflictDoNothing({
        target: [
          schema.apiIdempotency.userId,
          schema.apiIdempotency.operation,
          schema.apiIdempotency.idempotencyKey,
        ],
      })
      .returning({ id: schema.apiIdempotency.id });

    // We inserted it, so the work is ours to do.
    if (inserted[0] !== undefined) return null;

    const existing = await this.db
      .select()
      .from(schema.apiIdempotency)
      .where(
        and(
          eq(schema.apiIdempotency.userId, scope.userId),
          eq(schema.apiIdempotency.operation, scope.operation),
          eq(schema.apiIdempotency.idempotencyKey, scope.key),
        ),
      )
      .limit(1);

    const row = existing[0];
    if (row === undefined) return null;
    if (row.requestHash !== requestHash) throw REUSED_WITH_DIFFERENT_BODY;
    if (row.completedAt === null) throw IN_FLIGHT;
    return row.responseBody;
  }

  async complete(scope: IdempotencyScope, response: unknown): Promise<void> {
    await this.db
      .update(schema.apiIdempotency)
      .set({ responseBody: response ?? null, completedAt: sql`now()` })
      .where(
        and(
          eq(schema.apiIdempotency.userId, scope.userId),
          eq(schema.apiIdempotency.operation, scope.operation),
          eq(schema.apiIdempotency.idempotencyKey, scope.key),
        ),
      );
  }

  /**
   * Drops keys nobody will retry.
   *
   * Done on the way past rather than by a scheduled job: there is no worker in
   * this deployment, and a table swept every few hundred requests never gets
   * large enough to matter.
   */
  async sweep(): Promise<void> {
    await this.db
      .delete(schema.apiIdempotency)
      .where(lt(schema.apiIdempotency.createdAt, sql`now() - interval '24 hours'`));
  }
}

interface MemoryEntry {
  readonly requestHash: string;
  completed: boolean;
  response: unknown;
  readonly createdAt: number;
}

/** The same semantics, for the demonstration backend. */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, MemoryEntry>();

  private static id(scope: IdempotencyScope): string {
    return `${scope.userId}\u0000${scope.operation}\u0000${scope.key}`;
  }

  claim(scope: IdempotencyScope, requestHash: string): Promise<unknown | null> {
    const id = MemoryIdempotencyStore.id(scope);
    const existing = this.entries.get(id);

    if (existing === undefined) {
      this.entries.set(id, { requestHash, completed: false, response: null, createdAt: Date.now() });
      return Promise.resolve(null);
    }
    if (existing.requestHash !== requestHash) throw REUSED_WITH_DIFFERENT_BODY;
    if (!existing.completed) throw IN_FLIGHT;
    return Promise.resolve(existing.response);
  }

  complete(scope: IdempotencyScope, response: unknown): Promise<void> {
    const entry = this.entries.get(MemoryIdempotencyStore.id(scope));
    if (entry !== undefined) {
      entry.completed = true;
      entry.response = response;
    }
    return Promise.resolve();
  }

  /**
   * Releases a key whose work failed.
   *
   * PostgreSQL gets this free — the marker is rolled back with the failed
   * transaction. In memory there is nothing to roll back, so a failure has to
   * say so explicitly, or a retry of a genuinely failed operation would be
   * refused for ever.
   */
  release(scope: IdempotencyScope): void {
    const id = MemoryIdempotencyStore.id(scope);
    if (this.entries.get(id)?.completed === false) this.entries.delete(id);
  }
}
