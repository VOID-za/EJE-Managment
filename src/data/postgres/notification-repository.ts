import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  asJobId,
  asNotificationId,
  asUserId,
  type AppNotification,
  type NotificationId,
  type UserId,
} from '@/domain';
import type { NotificationRepository } from '@/data/repositories';
import type { DatabaseExecutor } from '@/db/client';
import * as schema from '@/db/schema';

type NotificationRow = typeof schema.notifications.$inferSelect;

const toDomainNotification = (row: NotificationRow): AppNotification => ({
  id: asNotificationId(row.id),
  recipientId: asUserId(row.recipientId),
  type: row.type,
  title: row.title,
  body: row.body,
  jobId: row.jobId === null ? null : asJobId(row.jobId),
  link: row.link,
  createdAt: row.createdAt,
  readAt: row.readAt,
  handledAt: row.handledAt,
  channels: row.channels,
});

/**
 * Per-recipient notifications, in PostgreSQL.
 *
 * ONE ROW PER RECIPIENT, deliberately. A refusal raised to three Masters is
 * three rows, because "read" and "handled" are per person and a shared row
 * cannot answer either. It is also what keeps a notification's body — which
 * DOES carry the customer's refusal reason — inside the store whose read rule
 * is "the recipient", rather than on the shared audit trail where a technician
 * could reach it.
 *
 * `notifications.job_id` is `on delete set null`: a job deleted under DECISION 6
 * takes its link with it, and the notification stays, because a notification
 * somebody has already read is a thing that happened to them.
 */
export class PostgresNotificationRepository implements NotificationRepository {
  constructor(private readonly db: DatabaseExecutor) {}

  async list(recipientId: UserId): Promise<readonly AppNotification[]> {
    const rows = await this.db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.recipientId, recipientId))
      .orderBy(desc(schema.notifications.createdAt));
    return rows.map(toDomainNotification);
  }

  async create(notification: AppNotification): Promise<AppNotification> {
    const inserted = await this.db
      .insert(schema.notifications)
      .values({
        id: notification.id,
        recipientId: notification.recipientId,
        type: notification.type,
        title: notification.title,
        body: notification.body,
        jobId: notification.jobId,
        link: notification.link,
        channels: [...notification.channels],
        createdAt: notification.createdAt,
        readAt: notification.readAt,
        handledAt: notification.handledAt,
      })
      .returning();
    return toDomainNotification(inserted[0]!);
  }

  /** Stamped once. Re-reading something does not move when you first read it. */
  async markRead(id: NotificationId): Promise<void> {
    await this.db
      .update(schema.notifications)
      .set({ readAt: sql`now()` })
      .where(and(eq(schema.notifications.id, id), isNull(schema.notifications.readAt)));
  }

  async markAllRead(recipientId: UserId): Promise<void> {
    await this.db
      .update(schema.notifications)
      .set({ readAt: sql`now()` })
      .where(
        and(
          eq(schema.notifications.recipientId, recipientId),
          isNull(schema.notifications.readAt),
        ),
      );
  }

  /**
   * The office has dealt with it.
   *
   * Handling implies reading, so an unread notification is marked read at the
   * same moment — otherwise an actioned approval request would sit in somebody's
   * unread count for ever.
   */
  async markHandled(id: NotificationId): Promise<void> {
    await this.db
      .update(schema.notifications)
      .set({
        handledAt: sql`now()`,
        readAt: sql`coalesce(${schema.notifications.readAt}, now())`,
      })
      .where(eq(schema.notifications.id, id));
  }
}
