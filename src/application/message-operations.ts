import {
  summariseAvailability,
  userFullName,
  type AvailabilityRecord,
  type TechnicianMessage,
  type UserId,
} from '@/domain';
import type { OperationContext } from './context';
import { audit, notifyMasters } from './audit';
import { WorkflowError } from './errors';

/**
 * Technician → Master messages.
 *
 * The rule that gives this feature its shape: sending a message never changes
 * anyone's availability. It reaches the office as a notification, and a Master
 * decides whether to put something on the calendar. If they do, the record is
 * linked back to the message so the thread shows what was done about it.
 */
export const sendMessageToMasters = async (
  context: OperationContext,
  body: string,
): Promise<TechnicianMessage> => {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    throw new WorkflowError('A message needs some text.', [
      { code: 'body_required', message: 'Type what you want the office to know.' },
    ]);
  }

  const message: TechnicianMessage = {
    id: context.services.ids.next('msg'),
    senderId: context.actor.id,
    // Addressed to the office rather than one person: whoever is at a desk
    // should be able to pick it up.
    recipientId: null,
    body: trimmed,
    sentAt: context.services.clock.now(),
    status: 'unread',
    readBy: null,
    readAt: null,
    availabilityRecordId: null,
    actionedBy: null,
    actionedAt: null,
  };

  const saved = await context.repos.messages.save(message);

  await notifyMasters(context, {
    type: 'technician_message',
    title: `${userFullName(context.actor)} sent you a message`,
    body: trimmed,
  });

  await audit(context, {
    jobId: null,
    type: 'message_sent',
    summary: `Message to the office from ${userFullName(context.actor)}`,
    // Stated explicitly, because it is the thing people assume wrongly.
    detail: `"${trimmed}" This is a message only — it does not change anyone's availability.`,
  });

  return saved;
};

export const markMessageRead = async (
  context: OperationContext,
  message: TechnicianMessage,
): Promise<TechnicianMessage> => {
  if (message.status !== 'unread') return message;
  return context.repos.messages.save({
    ...message,
    status: 'read',
    readBy: context.actor.id,
    readAt: context.services.clock.now(),
  });
};

/**
 * Links an availability record back to the message that prompted it.
 *
 * Called by the Master's "Mark unavailable" flow when it started from a
 * message, so the thread ends with what was actually done rather than trailing
 * off unanswered.
 */
export const attachAvailabilityToMessage = async (
  context: OperationContext,
  message: TechnicianMessage,
  record: AvailabilityRecord,
): Promise<TechnicianMessage> => {
  const now = context.services.clock.now();
  const saved = await context.repos.messages.save({
    ...message,
    status: 'actioned',
    readBy: message.readBy ?? context.actor.id,
    readAt: message.readAt ?? now,
    availabilityRecordId: record.id,
    actionedBy: context.actor.id,
    actionedAt: now,
  });

  await audit(context, {
    jobId: null,
    type: 'message_actioned',
    summary: 'Availability recorded from a technician message',
    detail: `${summariseAvailability(record)}. Recorded by ${userFullName(context.actor)}.`,
  });
  return saved;
};

/** Messages a Master has not dealt with yet. */
export const unhandledMessages = (
  messages: readonly TechnicianMessage[],
): readonly TechnicianMessage[] => messages.filter((message) => message.status !== 'actioned');

export const messagesFrom = (
  messages: readonly TechnicianMessage[],
  senderId: UserId,
): readonly TechnicianMessage[] => messages.filter((message) => message.senderId === senderId);
