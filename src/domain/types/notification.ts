import type { IsoDateTime, JobId, NotificationId, UserId } from './common';

export type NotificationType =
  | 'job_assigned'
  | 'job_transferred'
  | 'customer_change_request'
  | 'machine_approval_request'
  | 'document_approval_request'
  | 'job_submitted'
  /**
   * The customer refused to sign a job card. Raised to every active Master,
   * because issuing the job card waits on one of them reviewing it.
   */
  | 'signature_refused'
  /** A chat message from another user. Links to the conversation, not a job. */
  | 'chat_message'
  /** TS-02: a technician sent a timesheet period to the office. To Masters and Coordinators. */
  | 'timesheet_submitted'
  /** TS-16: a technician asked to correct a sent timesheet. To Masters and Coordinators. */
  | 'timesheet_correction_requested'
  /** TS-16: the office accepted or rejected the correction. To the technician. */
  | 'timesheet_correction_decided'
  /** STANDBY-5: a technician asked to swap a standby place. To Masters and Coordinators. */
  | 'standby_swap_requested'
  /** STANDBY-6: the office approved (to both people) or rejected (to the requester) a swap. */
  | 'standby_swap_decided'
  /** STANDBY-4: the office changed a published standby place this person was or is now in. */
  | 'standby_assignment_changed'
  // STANDBY-DAY-1 (2 November 2026): the two-stage day swap.
  | 'standby_day_swap_requested'
  | 'standby_day_swap_answered'
  | 'standby_day_swap_for_office'
  | 'standby_day_swap_decided';

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

/**
 * WHICH INBOX SUBTAB A NOTIFICATION BELONGS TO. NOTIF-TABS-1 (the tester,
 * 2 November 2026): Jobcards, Messages and Forms.
 *
 * A Record over every type, so adding a notification type without deciding
 * its subtab does not compile. Register approvals (a customer change, a
 * machine, a document) are office work raised from job cards and sit with
 * them.
 *
 * NOTIF-TABS-2 (2 November 2026): Forms becomes Monthly Forms, and every
 * standby notification has its own Standby subtab.
 */
export type NotificationCategory = 'jobcards' | 'messages' | 'monthly_forms' | 'standby';

export const NOTIFICATION_CATEGORY: Readonly<Record<NotificationType, NotificationCategory>> = {
  job_assigned: 'jobcards',
  job_transferred: 'jobcards',
  job_submitted: 'jobcards',
  signature_refused: 'jobcards',
  customer_change_request: 'jobcards',
  machine_approval_request: 'jobcards',
  document_approval_request: 'jobcards',
  chat_message: 'messages',
  timesheet_submitted: 'monthly_forms',
  timesheet_correction_requested: 'monthly_forms',
  timesheet_correction_decided: 'monthly_forms',
  standby_swap_requested: 'standby',
  standby_swap_decided: 'standby',
  standby_assignment_changed: 'standby',
  standby_day_swap_requested: 'standby',
  standby_day_swap_answered: 'standby',
  standby_day_swap_for_office: 'standby',
  standby_day_swap_decided: 'standby',
};

export const notificationCategory = (type: NotificationType): NotificationCategory =>
  NOTIFICATION_CATEGORY[type];
