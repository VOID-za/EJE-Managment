import {
  canReadConversation,
  isMessageRead,
  summariseAvailability,
  userFullName,
  type AvailabilityRecord,
  type ChatMessage,
  type Conversation,
  type Job,
  type User,
  type UserId,
} from '@/domain';
import type { OperationContext } from './context';
import { audit, notify } from './audit';
import { WorkflowError } from './errors';

/**
 * Internal chat.
 *
 * Two rules give this feature its shape, and both are enforced here rather than
 * left to a screen:
 *
 * 1. A message is people talking. Sending one raises a notification for the
 *    recipients and does nothing else — no job status change, no job note, no
 *    availability record. Those remain deliberate acts by someone authorised to
 *    perform them.
 * 2. A technician writing to "the office" reaches every active Master, because
 *    the point is that whoever is at a desk can pick it up. A Master writing to
 *    a technician is a direct thread.
 */

/** Who this user is allowed to start a conversation with. */
export const permittedRecipients = (
  actor: Pick<User, 'id' | 'role'>,
  users: readonly User[],
): readonly User[] =>
  users.filter((candidate) => {
    // A disabled account cannot sign in to read anything, so offering it as a
    // recipient would be a dead end. Existing threads with them stay readable.
    if (!candidate.active) return false;
    if (candidate.id === actor.id) return false;
    return actor.role === 'master' ? candidate.role === 'technician' : candidate.role === 'master';
  });

const assertParticipant = (conversation: Conversation, actor: User): void => {
  if (canReadConversation(conversation, actor.id)) return;
  throw new WorkflowError('That conversation is not yours.', [
    { code: 'not_a_participant', message: 'You can only read conversations you are part of.' },
  ]);
};

export interface StartConversationInput {
  /** Empty means "the office": every active Master. */
  readonly recipientIds: readonly UserId[];
  readonly body: string;
  readonly job?: Pick<Job, 'id' | 'jobNumber'> | null;
}

export interface SendResult {
  readonly conversation: Conversation;
  readonly message: ChatMessage;
}

const activeMasterIds = async (context: OperationContext): Promise<readonly UserId[]> => {
  const users = await context.repos.users.list();
  return users
    .filter((user) => user.role === 'master' && user.active && user.id !== context.actor.id)
    .map((user) => user.id);
};

/**
 * Starts a thread, or adds to the existing one with the same people about the
 * same job.
 *
 * Reusing the thread matters: two messages to the same person about nothing in
 * particular belong in one conversation, not two, or the list becomes a pile of
 * one-line threads.
 */
export const startConversation = async (
  context: OperationContext,
  input: StartConversationInput,
): Promise<SendResult> => {
  const body = input.body.trim();
  if (body.length === 0) {
    throw new WorkflowError('A message needs some text.', [
      { code: 'body_required', message: 'Type what you want to say.' },
    ]);
  }

  const recipientIds =
    input.recipientIds.length > 0 ? input.recipientIds : await activeMasterIds(context);
  if (recipientIds.length === 0) {
    throw new WorkflowError('There is nobody to send this to.', [
      { code: 'no_recipients', message: 'Choose at least one recipient.' },
    ]);
  }

  const users = await context.repos.users.list();
  for (const id of recipientIds) {
    const recipient = users.find((candidate) => candidate.id === id);
    if (recipient === undefined || !recipient.active) {
      throw new WorkflowError('That user cannot receive messages.', [
        { code: 'recipient_unavailable', message: 'The account is disabled or no longer exists.' },
      ]);
    }
  }

  const participantIds = [context.actor.id, ...recipientIds];
  const jobId = input.job?.id ?? null;

  const existing = (await context.repos.chat.listConversations(context.actor.id)).find(
    (conversation) =>
      conversation.jobId === jobId &&
      conversation.participantIds.length === participantIds.length &&
      participantIds.every((id) => conversation.participantIds.includes(id)),
  );

  const conversation =
    existing ??
    (await context.repos.chat.saveConversation({
      id: context.services.ids.next('conv'),
      participantIds,
      jobId,
      jobNumber: input.job?.jobNumber ?? null,
      createdBy: context.actor.id,
      createdAt: context.services.clock.now(),
      lastMessageAt: context.services.clock.now(),
    }));

  return sendMessage(context, conversation, body);
};

/** Adds a message to a thread the actor is already part of. */
export const sendMessage = async (
  context: OperationContext,
  conversation: Conversation,
  body: string,
): Promise<SendResult> => {
  assertParticipant(conversation, context.actor);

  const trimmed = body.trim();
  if (trimmed.length === 0) {
    throw new WorkflowError('A message needs some text.', [
      { code: 'body_required', message: 'Type what you want to say.' },
    ]);
  }

  const now = context.services.clock.now();
  const message = await context.repos.chat.saveMessage({
    id: context.services.ids.next('msg'),
    conversationId: conversation.id,
    senderId: context.actor.id,
    body: trimmed,
    sentAt: now,
    // The sender has obviously read their own message; `isMessageRead` treats
    // the sender as read without needing them in this list.
    readBy: [],
    availabilityRecordId: null,
    actionedBy: null,
    actionedAt: null,
  });

  const saved = await context.repos.chat.saveConversation({
    ...conversation,
    /*
     * When the newest message in this thread arrived — which can only move
     * forward.
     *
     * Taking `now` unconditionally let it move BACKWARDS, because a thread can
     * hold a message stamped later than now: seeded demonstration data used
     * fixed clock hours, so a demo opened early in the morning had threads
     * whose last message was still in the future. Replying then dropped the
     * thread down the list, and the Messages screen opened somebody else's
     * conversation.
     */
    lastMessageAt: now > conversation.lastMessageAt ? now : conversation.lastMessageAt,
  });

  // One notification per recipient, pointing at the conversation rather than a
  // job: a chat notification that opened the job would be the wrong place.
  for (const recipientId of conversation.participantIds) {
    if (recipientId === context.actor.id) continue;
    await notify(context, {
      recipientId,
      type: 'chat_message',
      title: `New message from ${context.actor.firstName}`,
      body: trimmed,
      link: `/messages?conversation=${saved.id}`,
      // Deliberately NOT jobId: this is not a job event, and setting it would
      // send the notification to the job screen.
      jobId: null,
    });
  }

  return { conversation: saved, message };
};

/**
 * Marks every message in a thread as read for the acting user.
 *
 * Also clears the matching chat notifications, so the unread badge on
 * Notifications does not keep claiming attention for something already read.
 */
export const markConversationRead = async (
  context: OperationContext,
  conversation: Conversation,
): Promise<number> => {
  assertParticipant(conversation, context.actor);

  const messages = await context.repos.chat.listMessages(conversation.id);
  const unread = messages.filter((message) => !isMessageRead(message, context.actor.id));

  for (const message of unread) {
    await context.repos.chat.saveMessage({
      ...message,
      readBy: [...message.readBy, context.actor.id],
    });
  }

  const notifications = await context.repos.notifications.list(context.actor.id);
  for (const notification of notifications) {
    if (notification.type !== 'chat_message') continue;
    if (notification.link !== `/messages?conversation=${conversation.id}`) continue;
    if (notification.readAt !== null) continue;
    await context.repos.notifications.markRead(notification.id);
  }

  return unread.length;
};

/** Total unread messages across every thread this user is in. */
export const unreadMessageCount = async (
  context: OperationContext,
  userId: UserId,
): Promise<number> => {
  const messages = await context.repos.chat.listMessagesFor(userId);
  return messages.filter((message) => !isMessageRead(message, userId)).length;
};

/**
 * Links an availability record back to the message that prompted it.
 *
 * Preserved from the one-way message board this replaced: a technician's
 * request and the office's decision stay connected, so the thread ends with
 * what was actually done rather than trailing off unanswered.
 */
export const attachAvailabilityToMessage = async (
  context: OperationContext,
  message: ChatMessage,
  record: AvailabilityRecord,
): Promise<ChatMessage> => {
  const now = context.services.clock.now();
  const saved = await context.repos.chat.saveMessage({
    ...message,
    readBy: message.readBy.includes(context.actor.id)
      ? message.readBy
      : [...message.readBy, context.actor.id],
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

/** A message the office has not yet turned into an availability record. */
export const isAwaitingAction = (message: ChatMessage): boolean =>
  message.availabilityRecordId === null;

export interface ConversationSummary {
  readonly conversation: Conversation;
  readonly participants: readonly User[];
  readonly lastMessage: ChatMessage | null;
  readonly unread: number;
  readonly total: number;
}

/** Everything the conversation list needs, assembled in one place. */
export const loadConversations = async (
  context: OperationContext,
): Promise<readonly ConversationSummary[]> => {
  const [conversations, users, messages] = await Promise.all([
    context.repos.chat.listConversations(context.actor.id),
    context.repos.users.list(),
    context.repos.chat.listMessagesFor(context.actor.id),
  ]);

  return conversations.map((conversation) => {
    const inThread = messages
      .filter((message) => message.conversationId === conversation.id)
      .sort((a, b) => a.sentAt.localeCompare(b.sentAt));

    return {
      conversation,
      participants: conversation.participantIds
        .filter((id) => id !== context.actor.id)
        .map((id) => users.find((user) => user.id === id))
        .filter((user): user is User => user !== undefined),
      lastMessage: inThread[inThread.length - 1] ?? null,
      unread: inThread.filter((message) => !isMessageRead(message, context.actor.id)).length,
      total: inThread.length,
    };
  });
};
