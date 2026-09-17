import {
  asActivityId,
  asJobId,
  asNotificationId,
  type ActivityEvent,
  type AppNotification,
  type NotificationChannel,
  type NotificationType,
  type UserId,
} from '@/domain';
import type { AuditInput, OperationContext } from './context';

/**
 * Audit and notification writes.
 *
 * Shared by every operation module so the trail is written the same way
 * everywhere: resolved at write time, attributed to the acting user, and
 * emitted by the business logic rather than by a screen.
 */
export const audit = async (
  context: OperationContext,
  input: AuditInput,
): Promise<ActivityEvent> => {
  const event: ActivityEvent = {
    id: asActivityId(context.services.ids.next('act')),
    jobId: input.jobId === null ? null : asJobId(input.jobId),
    type: input.type,
    summary: input.summary,
    detail: input.detail,
    actorId: context.actor.id,
    occurredAt: context.services.clock.now(),
  };
  return context.repos.activity.append(event);
};

export interface NotifyInput {
  readonly recipientId: UserId;
  readonly type: NotificationType;
  readonly title: string;
  readonly body: string;
  readonly jobId?: string | null;
  readonly channels?: readonly NotificationChannel[];
}

export const notify = async (
  context: OperationContext,
  input: NotifyInput,
): Promise<AppNotification> => {
  const notification: AppNotification = {
    id: asNotificationId(context.services.ids.next('ntf')),
    recipientId: input.recipientId,
    type: input.type,
    title: input.title,
    body: input.body,
    jobId: input.jobId === undefined || input.jobId === null ? null : asJobId(input.jobId),
    createdAt: context.services.clock.now(),
    readAt: null,
    handledAt: null,
    channels: input.channels ?? ['in_app'],
  };
  return context.repos.notifications.create(notification);
};

/** Every Master, for approval requests that any of them can action. */
export const notifyMasters = async (
  context: OperationContext,
  input: Omit<NotifyInput, 'recipientId'>,
): Promise<readonly AppNotification[]> => {
  const users = await context.repos.users.list();
  const masters = users.filter((user) => user.role === 'master' && user.active);
  return Promise.all(masters.map((master) => notify(context, { ...input, recipientId: master.id })));
};
