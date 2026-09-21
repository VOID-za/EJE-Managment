import { desc, eq, sql } from 'drizzle-orm';
import {
  MAX_OUTBOX_ATTEMPTS,
  type IsoDateTime,
  type JobId,
  type OutboxMessage,
  type OutboxState,
} from '@/domain';
import type { OutboxRepository } from '../repositories';
import * as schema from '@/db/schema';
import type { DatabaseExecutor } from '@/db/client';

type Row = typeof schema.outboxMessages.$inferSelect;

const toMessage = (row: Row): OutboxMessage => ({
  id: row.id,
  channel: row.channel as OutboxMessage['channel'],
  template: row.template,
  recipient: row.recipient,
  parameters: row.parameters,
  preview: row.preview,
  jobId: row.jobId === null ? null : (row.jobId as JobId),
  state: row.state as OutboxState,
  attempts: row.attempts,
  providerMessageId: row.providerMessageId,
  failureReason: row.failureReason,
  createdAt: row.createdAt as IsoDateTime,
  lastAttemptAt: row.lastAttemptAt === null ? null : (row.lastAttemptAt as IsoDateTime),
});

/**
 * The outbox on PostgreSQL.
 *
 * `enqueue` runs on the TRANSACTION of the business change, so the obligation
 * to send commits with the assignment that created it or neither happens. The
 * other three run on their own short transactions, AFTER that commit, which is
 * the whole reason this table exists: nothing holds a transaction open across a
 * call to Meta.
 */
export class PostgresOutboxRepository implements OutboxRepository {
  constructor(private readonly db: DatabaseExecutor) {}

  async enqueue(message: OutboxMessage): Promise<OutboxMessage> {
    await this.db.insert(schema.outboxMessages).values({
      id: message.id,
      channel: message.channel,
      template: message.template,
      recipient: message.recipient,
      parameters: [...message.parameters],
      preview: message.preview,
      jobId: message.jobId,
      state: message.state,
      attempts: message.attempts,
      providerMessageId: message.providerMessageId,
      failureReason: message.failureReason,
      createdAt: message.createdAt,
      lastAttemptAt: message.lastAttemptAt,
    });
    return message;
  }

  /**
   * Takes the outstanding messages and COUNTS THE ATTEMPT in the same statement.
   *
   * `for update skip locked` is what makes two requests draining at once safe:
   * each takes rows the other has not, so Meta is never handed the same message
   * twice because two people saved a job in the same second. Incrementing
   * `attempts` here rather than after the send is deliberate — a process that
   * dies mid-send has already spent its attempt, which is the safe direction to
   * be wrong in when the alternative is an infinite retry.
   */
  async claimSendable(limit: number, now: IsoDateTime): Promise<readonly OutboxMessage[]> {
    const claimed = await this.db.execute<Row>(sql`
      update ${schema.outboxMessages}
         set attempts = attempts + 1,
             last_attempt_at = ${now}
       where id in (
         select id from ${schema.outboxMessages}
          where state = 'pending'
            and attempts < ${MAX_OUTBOX_ATTEMPTS}
          order by created_at asc
          limit ${limit}
          for update skip locked
       )
      returning *
    `);

    return [...claimed].map((row) => toMessage(row as Row));
  }

  async markSent(id: string, providerMessageId: string, now: IsoDateTime): Promise<void> {
    await this.db
      .update(schema.outboxMessages)
      .set({ state: 'sent', providerMessageId, failureReason: '', lastAttemptAt: now })
      .where(eq(schema.outboxMessages.id, id));
  }

  /**
   * Records the failure and decides whether it is worth another go.
   *
   * `attempts` has already been counted by the claim, so the comparison is
   * against what has been spent rather than what is about to be.
   */
  async markFailed(id: string, reason: string, now: IsoDateTime): Promise<void> {
    await this.db
      .update(schema.outboxMessages)
      .set({
        state: sql`case when ${schema.outboxMessages.attempts} >= ${MAX_OUTBOX_ATTEMPTS} then 'failed' else 'pending' end`,
        failureReason: reason.slice(0, 2000),
        lastAttemptAt: now,
      })
      .where(eq(schema.outboxMessages.id, id));
  }

  async list(limit = 100): Promise<readonly OutboxMessage[]> {
    const rows = await this.db
      .select()
      .from(schema.outboxMessages)
      .orderBy(desc(schema.outboxMessages.createdAt))
      .limit(limit);
    return rows.map(toMessage);
  }
}
