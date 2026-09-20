import { asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { asJobId, asUserId, type ChatMessage, type Conversation, type UserId } from '@/domain';
import type { ChatRepository } from '@/data/repositories';
import type { DatabaseExecutor } from '@/db/client';
import * as schema from '@/db/schema';
import { isUuid } from './identifiers';

type ConversationRow = typeof schema.chatConversations.$inferSelect;
type MessageRow = typeof schema.chatMessages.$inferSelect;

/**
 * Internal chat, in PostgreSQL.
 *
 * Four tables where the demo had two arrays, and each split earns its place:
 *
 *  - PARTICIPANTS are a join table, so "which conversations are mine?" is an
 *    indexed lookup rather than a scan of every thread's array.
 *  - READS are a join table, so an unread count ACROSS conversations is an
 *    indexed query. A thread with the office has several recipients and "read"
 *    is per person, which an array column on the message cannot answer without
 *    being unpacked.
 *
 * MESSAGES ARE APPEND-ONLY — a trigger refuses a DELETE. What somebody said is
 * not something to edit later. What may still change is what was DONE about it:
 * the office linking the availability record they created from a technician's
 * request, and who has read it.
 */
export class PostgresChatRepository implements ChatRepository {
  constructor(private readonly db: DatabaseExecutor) {}

  async listConversations(userId: UserId): Promise<readonly Conversation[]> {
    const rows = await this.db
      .select()
      .from(schema.chatConversations)
      .where(
        sql`exists (
          select 1 from ${schema.chatParticipants}
           where ${schema.chatParticipants.conversationId} = ${schema.chatConversations.id}
             and ${schema.chatParticipants.userId} = ${userId}
        )`,
      )
      .orderBy(desc(schema.chatConversations.lastMessageAt));
    return this.withParticipants(rows);
  }

  async findConversation(id: string): Promise<Conversation | null> {
    if (!isUuid(id)) return null;
    const rows = await this.db
      .select()
      .from(schema.chatConversations)
      .where(eq(schema.chatConversations.id, id))
      .limit(1);
    const assembled = await this.withParticipants(rows);
    return assembled[0] ?? null;
  }

  async saveConversation(conversation: Conversation): Promise<Conversation> {
    const values = {
      jobId: conversation.jobId,
      // Kept as text as well as by id, so the thread still names the job after a
      // permanent deletion takes the foreign key to null.
      jobNumber: conversation.jobNumber,
      lastMessageAt: conversation.lastMessageAt,
    } as const;

    await this.db
      .insert(schema.chatConversations)
      .values({
        id: conversation.id,
        ...values,
        createdBy: conversation.createdBy,
        createdAt: conversation.createdAt,
      })
      .onConflictDoUpdate({ target: schema.chatConversations.id, set: { ...values } });

    /*
     * Participants are added, never removed.
     *
     * Leaving a thread is not something the application does, and silently
     * dropping somebody would take their history of it with them. A row that is
     * already there is left exactly as it is, so `joined_at` stays true.
     */
    if (conversation.participantIds.length > 0) {
      await this.db
        .insert(schema.chatParticipants)
        .values(
          conversation.participantIds.map((userId) => ({
            conversationId: conversation.id,
            userId: userId as string,
          })),
        )
        .onConflictDoNothing();
    }

    const saved = await this.findConversation(conversation.id);
    if (saved === null) throw new Error(`Conversation ${conversation.id} vanished during save.`);
    return saved;
  }

  /** Oldest first: a conversation reads downwards. */
  async listMessages(conversationId: string): Promise<readonly ChatMessage[]> {
    const rows = await this.db
      .select()
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.conversationId, conversationId))
      .orderBy(asc(schema.chatMessages.sentAt));
    return this.withReads(rows);
  }

  async listMessagesFor(userId: UserId): Promise<readonly ChatMessage[]> {
    const rows = await this.db
      .select()
      .from(schema.chatMessages)
      .where(
        sql`exists (
          select 1 from ${schema.chatParticipants}
           where ${schema.chatParticipants.conversationId} = ${schema.chatMessages.conversationId}
             and ${schema.chatParticipants.userId} = ${userId}
        )`,
      )
      .orderBy(asc(schema.chatMessages.sentAt));
    return this.withReads(rows);
  }

  async findMessage(id: string): Promise<ChatMessage | null> {
    if (!isUuid(id)) return null;
    const rows = await this.db
      .select()
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.id, id))
      .limit(1);
    const assembled = await this.withReads(rows);
    return assembled[0] ?? null;
  }

  async saveMessage(message: ChatMessage): Promise<ChatMessage> {
    await this.db
      .insert(schema.chatMessages)
      .values({
        id: message.id,
        conversationId: message.conversationId,
        senderId: message.senderId,
        body: message.body,
        sentAt: message.sentAt,
        availabilityRecordId: message.availabilityRecordId,
        actionedBy: message.actionedBy,
        actionedAt: message.actionedAt,
      })
      // The body, the sender and the time are never rewritten — only what the
      // office did about it afterwards.
      .onConflictDoUpdate({
        target: schema.chatMessages.id,
        set: {
          availabilityRecordId: message.availabilityRecordId,
          actionedBy: message.actionedBy,
          actionedAt: message.actionedAt,
        },
      });

    if (message.readBy.length > 0) {
      await this.db
        .insert(schema.chatMessageReads)
        .values(
          message.readBy.map((userId) => ({
            messageId: message.id,
            userId: userId as string,
            readAt: sql`now()`,
          })),
        )
        // When somebody first read it is not something a later save moves.
        .onConflictDoNothing();
    }

    const saved = await this.findMessage(message.id);
    if (saved === null) throw new Error(`Message ${message.id} vanished during save.`);
    return saved;
  }

  /* ---------------------------------------------------------------------- */

  private async withParticipants(
    rows: readonly ConversationRow[],
  ): Promise<readonly Conversation[]> {
    if (rows.length === 0) return [];
    const participants = await this.db
      .select()
      .from(schema.chatParticipants)
      .where(
        inArray(
          schema.chatParticipants.conversationId,
          rows.map((row) => row.id),
        ),
      )
      .orderBy(asc(schema.chatParticipants.joinedAt));

    return rows.map((row) => ({
      id: row.id,
      participantIds: participants
        .filter((participant) => participant.conversationId === row.id)
        .map((participant) => asUserId(participant.userId)),
      jobId: row.jobId === null ? null : asJobId(row.jobId),
      jobNumber: row.jobNumber,
      createdBy: asUserId(row.createdBy ?? ''),
      createdAt: row.createdAt,
      lastMessageAt: row.lastMessageAt,
    }));
  }

  private async withReads(rows: readonly MessageRow[]): Promise<readonly ChatMessage[]> {
    if (rows.length === 0) return [];
    const reads = await this.db
      .select()
      .from(schema.chatMessageReads)
      .where(
        inArray(
          schema.chatMessageReads.messageId,
          rows.map((row) => row.id),
        ),
      );

    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversationId,
      senderId: asUserId(row.senderId),
      body: row.body,
      sentAt: row.sentAt,
      readBy: reads
        .filter((read) => read.messageId === row.id)
        .map((read) => asUserId(read.userId)),
      availabilityRecordId: row.availabilityRecordId,
      actionedBy: row.actionedBy === null ? null : asUserId(row.actionedBy),
      actionedAt: row.actionedAt,
    }));
  }
}
