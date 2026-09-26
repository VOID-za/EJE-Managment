import {
  asActivityId,
  asJobId,
  asNotificationId,
  type ActivityEvent,
  type AppNotification,
  type AuditValue,
  type FieldChange,
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
/**
 * The fields that actually moved, as an audit event's `changes`. AUDIT-2.
 *
 * Only genuine differences: a screen that posts a whole form back unchanged
 * must not fill the trail with sixteen "from X to X" entries, so a field whose
 * value is identical is left out entirely, and an operation where nothing moved
 * records no changes at all.
 *
 * `prefix` namespaces the keys — `labour.hours`, `rates.callout` — so a reader
 * of the trail can tell a labour line's date from a travel line's without
 * consulting the event type.
 */
export const changesBetween = (
  prefix: string,
  before: Readonly<Record<string, AuditValue>>,
  after: Readonly<Record<string, AuditValue>>,
): readonly FieldChange[] =>
  Object.keys(after)
    .filter((key) => before[key] !== after[key])
    .map((key) => ({
      field: `${prefix}.${key}`,
      from: before[key] ?? null,
      to: after[key] ?? null,
    }));

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
    // Empty unless the caller had a before and an after to record. AUDIT-2.
    changes: input.changes ?? [],
  };
  return context.repos.activity.append(event);
};

export interface NotifyInput {
  readonly recipientId: UserId;
  readonly type: NotificationType;
  readonly title: string;
  readonly body: string;
  readonly jobId?: string | null;
  /** Explicit destination. Omitted for a job notification, which uses the job. */
  readonly link?: string | null;
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
    link: input.link ?? null,
    createdAt: context.services.clock.now(),
    readAt: null,
    handledAt: null,
    channels: input.channels ?? ['in_app'],
  };
  return context.repos.notifications.create(notification);
};

/**
 * Every active Master, for anything the office collectively has to action.
 *
 * Disabled accounts are skipped — a notification nobody can sign in to read is
 * not a notification. The acting user is skipped too: being told about
 * something you just did yourself is noise, and it keeps the unread count
 * meaningful.
 */
export const notifyMasters = async (
  context: OperationContext,
  input: Omit<NotifyInput, 'recipientId'>,
): Promise<readonly AppNotification[]> => {
  const users = await context.repos.users.list();
  const masters = users.filter(
    (user) => user.role === 'master' && user.active && user.id !== context.actor.id,
  );
  return Promise.all(masters.map((master) => notify(context, { ...input, recipientId: master.id })));
};

/**
 * Everyone in the office — Masters and Coordinators — for work either can do.
 *
 * Distinct from `notifyMasters` on purpose. Some things are a Master's alone
 * (another Master's account, the charge-out rates); handling a customer who
 * would not sign is not one of them, and sending it only to Masters would
 * leave the Coordinator to find out by chance about work she is expected to
 * do. Disabled accounts and the acting user are skipped, as above.
 */
export const notifyOffice = async (
  context: OperationContext,
  input: Omit<NotifyInput, 'recipientId'>,
): Promise<readonly AppNotification[]> => {
  const users = await context.repos.users.list();
  const office = users.filter(
    (user) =>
      (user.role === 'master' || user.role === 'coordinator') &&
      user.active &&
      user.id !== context.actor.id,
  );
  return Promise.all(office.map((person) => notify(context, { ...input, recipientId: person.id })));
};
