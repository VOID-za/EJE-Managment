import type { IsoDateTime, JobId } from './common';

/**
 * A message that has to leave the building, recorded before it does.
 *
 * WHY THIS EXISTS. The assignment notification used to call WhatsApp from
 * inside the database transaction that recorded the assignment. Two things were
 * wrong with that, and the second is worse than the first:
 *
 *  1. A PostgreSQL transaction stayed open across a network round trip to Meta.
 *     Under load that is how a connection pool runs out.
 *  2. There was nowhere that remembered a message still needed sending. Commit
 *     the assignment, fail the HTTP call, and the only trace was an audit line
 *     saying it had failed — nothing to retry from.
 *
 * So the transaction now writes a ROW saying what must be sent, and commits.
 * Delivery happens afterwards, outside any transaction, and updates the row
 * with what actually happened. A message nobody managed to send is still
 * sitting there, `pending`, waiting for the next attempt.
 *
 * WHAT THIS IS NOT: a job queue. There is no scheduler, no worker process and
 * no broker. It is one table, written in the transaction that creates the
 * obligation and drained by the request that created it — with every later
 * mutation picking up whatever the last one failed to send.
 */
export type OutboxState =
  /** Recorded, not yet handed to the provider. The state a retry looks for. */
  | 'pending'
  /**
   * The PROVIDER ACCEPTED IT. Not "the technician received it".
   *
   * WhatsApp answers a send with a message id, which means Meta has it. Only a
   * delivery webhook could ever justify anything stronger, and this deployment
   * has none — see `docs/integrations.md`.
   */
  | 'sent'
  /** Given up on, after enough attempts. Says why. */
  | 'failed';

export interface OutboxMessage {
  readonly id: string;
  readonly channel: 'whatsapp' | 'email';
  /** The approved template name on the provider. */
  readonly template: string;
  /** Where it goes. A mobile number for WhatsApp. */
  readonly recipient: string;
  /** The template's body placeholders, in order. */
  readonly parameters: readonly string[];
  /** What the message will say, for the outbox screen and the audit trail. */
  readonly preview: string;
  /** The job this is about, by value. Null for anything that is not about one. */
  readonly jobId: JobId | null;
  readonly state: OutboxState;
  readonly attempts: number;
  /** The provider's own id, once there is one. Null until then. */
  readonly providerMessageId: string | null;
  readonly failureReason: string;
  readonly createdAt: IsoDateTime;
  readonly lastAttemptAt: IsoDateTime | null;
}

/**
 * How many times a message is tried before it is left alone.
 *
 * Small on purpose. These are notifications, not payments: a technician who was
 * not reached on the fourth attempt needs a telephone call, not a fifth.
 */
export const MAX_OUTBOX_ATTEMPTS = 4;

export const isOutboxSendable = (message: OutboxMessage): boolean =>
  message.state === 'pending' && message.attempts < MAX_OUTBOX_ATTEMPTS;
