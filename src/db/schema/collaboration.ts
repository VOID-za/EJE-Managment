import { sql } from 'drizzle-orm';
import { index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, instant, primaryId } from './columns';
import { notificationChannel, notificationType } from './enums';
import { availability } from './availability';
import { jobs } from './jobs';
import { users } from './identity';

/**
 * System notifications.
 *
 * DELIBERATELY SEPARATE FROM CHAT. A notification is the system reporting
 * something the recipient has to know about; a chat message is one person
 * telling another something. They have different lifecycles, different read
 * semantics and different screens, and merging them would make "unread" mean
 * two things at once.
 *
 * Also separate from audit events and from job notes, for the same reason.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: primaryId(),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: notificationType('type').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    /**
     * The job this is about, where there is one.
     *
     * `set null` rather than `cascade`: DECISION 6 deletes a job permanently,
     * and a notification already read is a thing that happened to its recipient.
     */
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    /** Where clicking it goes. Explicit, because a chat notification opens a conversation. */
    link: text('link'),
    channels: notificationChannel('channels').array().notNull(),

    createdAt: createdAt(),
    readAt: instant('read_at'),
    /** Set when the office has actioned an approval-style notification. */
    handledAt: instant('handled_at'),
    handledBy: uuid('handled_by').references(() => users.id),
  },
  (table) => [
    index('notifications_recipient_idx').on(table.recipientId, table.createdAt),
    index('notifications_unread_idx')
      .on(table.recipientId)
      .where(sql`${table.readAt} is null`),
    index('notifications_job_idx')
      .on(table.jobId)
      .where(sql`${table.jobId} is not null`),
  ],
);

/** A two-way thread. Optionally about a job. */
export const chatConversations = pgTable(
  'chat_conversations',
  {
    id: primaryId(),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    /** Kept as text so the thread still names the job after a permanent deletion. */
    jobNumber: text('job_number'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
    lastMessageAt: instant('last_message_at').notNull(),
  },
  (table) => [index('chat_conversations_recent_idx').on(table.lastMessageAt)],
);

export const chatParticipants = pgTable(
  'chat_participants',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => chatConversations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    joinedAt: createdAt(),
  },
  (table) => [
    uniqueIndex('chat_participants_pkey').on(table.conversationId, table.userId),
    index('chat_participants_user_idx').on(table.userId),
  ],
);

/** A message. APPEND-ONLY: what somebody said is not something to edit later. */
export const chatMessages = pgTable(
  'chat_messages',
  {
    id: primaryId(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => chatConversations.id, { onDelete: 'cascade' }),
    senderId: uuid('sender_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    body: text('body').notNull(),
    sentAt: instant('sent_at').notNull(),

    /**
     * The availability record the office created in response to this message.
     *
     * This is the link that keeps the two concepts separate while still showing
     * the thread what was done about it: a technician's "I have a dentist
     * appointment" stays a message, and the record the Master created from it
     * is referenced rather than conflated with it.
     */
    availabilityRecordId: uuid('availability_record_id').references(() => availability.id),
    actionedBy: uuid('actioned_by').references(() => users.id),
    actionedAt: instant('actioned_at'),
    createdAt: createdAt(),
  },
  (table) => [index('chat_messages_conversation_idx').on(table.conversationId, table.sentAt)],
);

/**
 * Who has read which message.
 *
 * A join table rather than an array column on the message, so an unread count
 * across conversations is an indexed query rather than an array scan.
 */
export const chatMessageReads = pgTable(
  'chat_message_reads',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => chatMessages.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    readAt: instant('read_at').notNull(),
  },
  (table) => [
    uniqueIndex('chat_message_reads_pkey').on(table.messageId, table.userId),
    index('chat_message_reads_user_idx').on(table.userId),
  ],
);
