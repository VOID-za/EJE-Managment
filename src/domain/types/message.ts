import type { IsoDateTime, JobId, UserId } from './common';

/**
 * Internal chat between Masters and Technicians.
 *
 * This grew out of the one-way "technician tells the office about their
 * availability" feature, and it deliberately keeps that behaviour rather than
 * running alongside a second messaging system: an availability request is now
 * simply a message in a conversation with the office, and the record a Master
 * creates in response is still linked back to the exact message that prompted
 * it.
 *
 * What it is NOT: a job note, a notification, or anything that can change a
 * job. A message is people talking. Sending one raises a notification for the
 * recipient and nothing else — no status change, no availability record, no
 * entry on the job. Those remain deliberate acts by someone with the authority
 * to perform them.
 */
export interface Conversation {
  readonly id: string;
  /**
   * Everyone in the thread.
   *
   * Two people for a direct chat. A technician writing to "the office" gets a
   * thread with every active Master in it, which is how that request reaches
   * whoever is at a desk rather than one named person.
   */
  readonly participantIds: readonly UserId[];
  /** Optional job the conversation is about, so it can be opened from here. */
  readonly jobId: JobId | null;
  readonly jobNumber: string | null;
  readonly createdBy: UserId;
  readonly createdAt: IsoDateTime;
  /** Sort key for the conversation list. */
  readonly lastMessageAt: IsoDateTime;
  /**
   * WHO HAS DELETED THIS CHAT FROM THEIR OWN LIST, AND WHEN. CHAT-DELETE-1
   * (27 October 2026). Deleting is per person: the chat leaves THAT person's
   * list, the other participants keep it, and every message is retained (some
   * carry availability evidence, and the office's technician record reads
   * them). A message sent after the deletion brings the chat back for that
   * person, showing only what came after. Optional: a conversation nobody has
   * deleted carries none.
   */
  readonly deletedFor?: Readonly<Record<string, IsoDateTime>>;
}

export interface ChatMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly senderId: UserId;
  readonly body: string;
  readonly sentAt: IsoDateTime;
  /**
   * Who has read it. A list rather than a flag because a thread with the office
   * has several recipients, and "read" is per person.
   */
  readonly readBy: readonly UserId[];
  /**
   * The availability record a Master created in response to this message.
   *
   * Carried on the message, not the conversation: it records that one specific
   * request was actioned, which is what the technician and the audit trail both
   * need to be able to see.
   */
  readonly availabilityRecordId: string | null;
  readonly actionedBy: UserId | null;
  readonly actionedAt: IsoDateTime | null;
}

export const isMessageRead = (message: ChatMessage, userId: UserId): boolean =>
  message.senderId === userId || message.readBy.includes(userId);

/** A message a Master has turned into an availability record. */
export const isMessageActioned = (message: ChatMessage): boolean =>
  message.availabilityRecordId !== null;

/** Messages in this thread the given user has not read. */
export const unreadIn = (
  messages: readonly ChatMessage[],
  userId: UserId,
): readonly ChatMessage[] => messages.filter((message) => !isMessageRead(message, userId));

export const conversationParticipants = (
  conversation: Conversation,
  userId: UserId,
): readonly UserId[] => conversation.participantIds.filter((id) => id !== userId);

/** Whether this user may read the thread at all. */
export const canReadConversation = (conversation: Conversation, userId: UserId): boolean =>
  conversation.participantIds.includes(userId);

/** When this person deleted the chat from their list, or null. CHAT-DELETE-1. */
export const deletedAtFor = (conversation: Conversation, userId: UserId): IsoDateTime | null =>
  conversation.deletedFor?.[userId] ?? null;

/** Whether the chat is on this person's list: never deleted, or written to since. */
export const isConversationListedFor = (conversation: Conversation, userId: UserId): boolean => {
  const deletedAt = deletedAtFor(conversation, userId);
  return deletedAt === null || conversation.lastMessageAt > deletedAt;
};

/** The messages this person still sees in a chat: those after their deletion, if any. */
export const messagesVisibleTo = <T extends Pick<ChatMessage, 'sentAt'>>(
  conversation: Conversation,
  userId: UserId,
  messages: readonly T[],
): readonly T[] => {
  const deletedAt = deletedAtFor(conversation, userId);
  return deletedAt === null ? messages : messages.filter((message) => message.sentAt > deletedAt);
};
