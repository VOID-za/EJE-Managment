import type { IsoDateTime, JobId, NotificationId, UserId } from './common';

export type NotificationType =
  | 'job_assigned'
  | 'job_transferred'
  | 'customer_change_request'
  | 'machine_approval_request'
  | 'document_approval_request'
  | 'job_submitted'
  /** A chat message from another user. Links to the conversation, not a job. */
  | 'chat_message';

export type NotificationChannel = 'in_app' | 'whatsapp' | 'email';

export interface AppNotification {
  readonly id: NotificationId;
  readonly recipientId: UserId;
  readonly type: NotificationType;
  readonly title: string;
  readonly body: string;
  readonly jobId: JobId | null;
  /**
   * Where clicking this notification should go.
   *
   * Set explicitly rather than derived, because not every notification is about
   * a job: a chat message opens its conversation. Null falls back to the job,
   * which keeps every existing notification behaving as it did.
   */
  readonly link: string | null;
  readonly createdAt: IsoDateTime;
  readonly readAt: IsoDateTime | null;
  /** Set when a Master has actioned an approval-style notification. */
  readonly handledAt: IsoDateTime | null;
  /**
   * Channels this notification would be delivered on in production. In the demo
   * the non-`in_app` channels are recorded in the simulated outbox and are never
   * actually sent.
   */
  readonly channels: readonly NotificationChannel[];
}
