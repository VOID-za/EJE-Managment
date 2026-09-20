import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  asNotificationId,
  asUserId,
  isMessageRead,
  unreadIn,
  type AppNotification,
  type AvailabilityRecord,
  type ChatMessage,
  type Conversation,
} from '@/domain';
import type { Database } from '@/db/client';
import { PostgresAvailabilityRepository } from './availability-repository';
import { PostgresChatRepository } from './chat-repository';
import { PostgresNotificationRepository } from './notification-repository';
import { ConcurrencyError } from './transaction';
import { openTestDatabase, testDatabaseUrl, truncateAll } from './test-database';
import { IDS, seedBaseline } from './test-fixtures';

/**
 * Notifications, chat and availability, in PostgreSQL.
 *
 * Three stores that the schema deliberately keeps apart, and this is where that
 * separation is checked rather than asserted. A notification is the system
 * telling somebody something; a message is one person telling another; an
 * availability record is the office putting an absence on the calendar. A
 * technician's "I have a dentist appointment" is a MESSAGE, and the record a
 * Master creates from it is linked to that message rather than being it.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

describeDb('collaboration in PostgreSQL', () => {
  let db: Database;
  let notifications: PostgresNotificationRepository;
  let chat: PostgresChatRepository;
  let availability: PostgresAvailabilityRepository;

  beforeAll(async () => {
    db = await openTestDatabase(url ?? '');
  });

  afterAll(async () => {
    await db.execute(sql`select 1`);
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seedBaseline(db);
    notifications = new PostgresNotificationRepository(db);
    chat = new PostgresChatRepository(db);
    availability = new PostgresAvailabilityRepository(db);
  });

  const newNotification = (over: Partial<AppNotification> = {}): AppNotification => ({
    id: asNotificationId(crypto.randomUUID()),
    recipientId: asUserId(IDS.master),
    type: 'signature_refused',
    title: 'Customer would not sign',
    body: 'The site manager walked off before signing.',
    jobId: null,
    link: null,
    createdAt: '2026-09-20T11:00:00.000Z',
    readAt: null,
    handledAt: null,
    channels: ['in_app'],
    ...over,
  });

  describe('notifications', () => {
    it('reaches its recipient and nobody else', async () => {
      await notifications.create(newNotification());
      await notifications.create(
        newNotification({ recipientId: asUserId(IDS.coordinator), title: 'For the office' }),
      );

      const forMaster = await notifications.list(asUserId(IDS.master));
      const forTechnician = await notifications.list(asUserId(IDS.technician));

      expect(forMaster).toHaveLength(1);
      // The refusal reason travels to the people entitled to it, per recipient,
      // and never onto the shared trail.
      expect(forMaster[0]?.body).toContain('walked off');
      expect(forTechnician).toHaveLength(0);
    });

    it('stamps when it was first read, and does not move it afterwards', async () => {
      const created = await notifications.create(newNotification());
      await notifications.markRead(created.id);
      const first = (await notifications.list(asUserId(IDS.master)))[0]?.readAt;
      expect(first).not.toBeNull();

      await notifications.markRead(created.id);
      const second = (await notifications.list(asUserId(IDS.master)))[0]?.readAt;
      expect(second).toBe(first);
    });

    it('marks everything of one person’s read, and leaves everyone else alone', async () => {
      await notifications.create(newNotification());
      await notifications.create(newNotification({ title: 'Second' }));
      await notifications.create(newNotification({ recipientId: asUserId(IDS.coordinator) }));

      await notifications.markAllRead(asUserId(IDS.master));

      const mine = await notifications.list(asUserId(IDS.master));
      const theirs = await notifications.list(asUserId(IDS.coordinator));
      expect(mine.every((entry) => entry.readAt !== null)).toBe(true);
      expect(theirs.every((entry) => entry.readAt === null)).toBe(true);
    });

    it('treats handling as reading, so an actioned request leaves the unread count', async () => {
      const created = await notifications.create(
        newNotification({ type: 'machine_approval_request', title: 'Machine awaiting approval' }),
      );
      await notifications.markHandled(created.id);

      const read = (await notifications.list(asUserId(IDS.master)))[0];
      expect(read?.handledAt).not.toBeNull();
      expect(read?.readAt).not.toBeNull();
    });

    it('keeps a notification about a job that has since been deleted', async () => {
      const jobId = crypto.randomUUID();
      await db.execute(sql`
        insert into jobs (id, job_number, job_number_seq, customer_id, site_id, contact_id,
                          job_type_code, priority, status, created_by)
        values (${jobId}, 'EJE-9100', 9100, ${IDS.customer}, ${IDS.site}, ${IDS.contact},
                'breakdown', 'urgent', 'open', ${IDS.master})
      `);
      await notifications.create(
        newNotification({ jobId: jobId as never, title: 'Job assigned' }),
      );

      await db.execute(sql`delete from jobs where id = ${jobId}`);

      // DECISION 6 removes the job; what happened to the recipient still did.
      const read = await notifications.list(asUserId(IDS.master));
      expect(read).toHaveLength(1);
      expect(read[0]?.jobId).toBeNull();
      expect(read[0]?.title).toBe('Job assigned');
    });
  });

  describe('chat', () => {
    const conversation = (over: Partial<Conversation> = {}): Conversation => ({
      id: crypto.randomUUID(),
      participantIds: [asUserId(IDS.technician), asUserId(IDS.master)],
      jobId: null,
      jobNumber: null,
      createdBy: asUserId(IDS.technician),
      createdAt: '2026-09-20T06:00:00.000Z',
      lastMessageAt: '2026-09-20T06:00:00.000Z',
      ...over,
    });

    const message = (conversationId: string, over: Partial<ChatMessage> = {}): ChatMessage => ({
      id: crypto.randomUUID(),
      conversationId,
      senderId: asUserId(IDS.technician),
      body: 'I have a dentist appointment on Thursday morning.',
      sentAt: '2026-09-20T06:00:00.000Z',
      readBy: [],
      availabilityRecordId: null,
      actionedBy: null,
      actionedAt: null,
      ...over,
    });

    it('lists a thread for its participants and for nobody else', async () => {
      const saved = await chat.saveConversation(conversation());

      expect(await chat.listConversations(asUserId(IDS.technician))).toHaveLength(1);
      expect(await chat.listConversations(asUserId(IDS.master))).toHaveLength(1);
      expect(await chat.listConversations(asUserId(IDS.otherTechnician))).toHaveLength(0);
      expect(saved.participantIds).toHaveLength(2);
    });

    it('reads downwards, oldest first', async () => {
      const thread = await chat.saveConversation(conversation());
      await chat.saveMessage(message(thread.id, { body: 'First', sentAt: '2026-09-20T06:00:00.000Z' }));
      await chat.saveMessage(message(thread.id, { body: 'Second', sentAt: '2026-09-20T07:00:00.000Z' }));

      const messages = await chat.listMessages(thread.id);
      expect(messages.map((entry) => entry.body)).toEqual(['First', 'Second']);
    });

    it('records who has read a message, one person at a time', async () => {
      const thread = await chat.saveConversation(conversation());
      const sent = await chat.saveMessage(message(thread.id));

      expect(isMessageRead(sent, asUserId(IDS.master))).toBe(false);
      const read = await chat.saveMessage({ ...sent, readBy: [asUserId(IDS.master)] });
      expect(isMessageRead(read, asUserId(IDS.master))).toBe(true);

      // The sender counts as having read their own message; the domain says so.
      const unread = unreadIn([read], asUserId(IDS.technician));
      expect(unread).toHaveLength(0);
    });

    it('links the availability record the office created, without becoming one', async () => {
      const thread = await chat.saveConversation(conversation());
      const request = await chat.saveMessage(message(thread.id));

      const record = await availability.save({
        id: crypto.randomUUID(),
        userId: asUserId(IDS.technician),
        type: 'appointment',
        startDate: '2026-09-24',
        endDate: '2026-09-24',
        allDay: false,
        startTime: '08:00',
        endTime: '11:00',
        description: 'Dentist',
        status: 'active',
        createdBy: asUserId(IDS.master),
        createdAt: '2026-09-20T08:00:00.000Z',
        cancelledBy: null,
        cancelledAt: null,
      });

      const actioned = await chat.saveMessage({
        ...request,
        availabilityRecordId: record.id,
        actionedBy: asUserId(IDS.master),
        actionedAt: '2026-09-20T08:00:00.000Z',
      });

      expect(actioned.availabilityRecordId).toBe(record.id);
      // The message is still what the technician wrote, not a calendar entry.
      expect(actioned.body).toContain('dentist appointment');
    });

    it('never rewrites what somebody said', async () => {
      const thread = await chat.saveConversation(conversation());
      const sent = await chat.saveMessage(message(thread.id));

      await chat.saveMessage({ ...sent, body: 'Something else entirely' });

      const read = await chat.findMessage(sent.id);
      expect(read?.body).toBe('I have a dentist appointment on Thursday morning.');
    });

    it('counts unread across every thread this person is in', async () => {
      const first = await chat.saveConversation(conversation());
      const second = await chat.saveConversation(
        conversation({ participantIds: [asUserId(IDS.technician), asUserId(IDS.coordinator)] }),
      );
      await chat.saveMessage(message(first.id));
      await chat.saveMessage(message(second.id, { senderId: asUserId(IDS.coordinator) }));

      const mine = await chat.listMessagesFor(asUserId(IDS.technician));
      expect(mine).toHaveLength(2);
      expect(unreadIn(mine, asUserId(IDS.technician))).toHaveLength(1);

      // The Master is in one of the two threads, and sees only that one.
      expect(await chat.listMessagesFor(asUserId(IDS.master))).toHaveLength(1);
    });
  });

  describe('availability', () => {
    const record = (over: Partial<AvailabilityRecord> = {}): AvailabilityRecord => ({
      id: crypto.randomUUID(),
      userId: asUserId(IDS.technician),
      type: 'annual_leave',
      startDate: '2026-10-05',
      endDate: '2026-10-09',
      allDay: true,
      startTime: null,
      endTime: null,
      description: 'Family holiday',
      status: 'active',
      createdBy: asUserId(IDS.master),
      createdAt: '2026-09-01T08:00:00.000Z',
      cancelledBy: null,
      cancelledAt: null,
      ...over,
    });

    it('returns anything OVERLAPPING the window, not only what it contains', async () => {
      await availability.save(record());

      // A window entirely inside the absence: containment would miss it, and a
      // missed block is how a double booking gets made.
      const inside = await availability.list('2026-10-06', '2026-10-07');
      expect(inside).toHaveLength(1);

      // One that starts before it and ends inside it.
      const straddling = await availability.list('2026-10-01', '2026-10-06');
      expect(straddling).toHaveLength(1);

      const after = await availability.list('2026-10-10', '2026-10-12');
      expect(after).toHaveLength(0);
    });

    it('keeps a part-day window as the wall-clock times the office entered', async () => {
      const saved = await availability.save(
        record({
          type: 'appointment',
          startDate: '2026-10-05',
          endDate: '2026-10-05',
          allDay: false,
          startTime: '09:00',
          endTime: '11:30',
        }),
      );
      expect(saved.startTime).toBe('09:00');
      expect(saved.endTime).toBe('11:30');
    });

    it('cancels by status, never by removal', async () => {
      const saved = await availability.save(record());
      const cancelled = await availability.save({
        ...saved,
        status: 'cancelled',
        cancelledBy: asUserId(IDS.master),
        cancelledAt: '2026-09-15T10:00:00.000Z',
      });

      expect(cancelled.status).toBe('cancelled');
      // Still on file, so the audit trail can say what was cancelled and when.
      expect(await availability.findById(saved.id)).not.toBeNull();
      expect((await availability.listForUser(asUserId(IDS.technician)))).toHaveLength(1);
    });

    it('refuses a cancellation with no timestamp behind it', async () => {
      const saved = await availability.save(record());
      await expect(
        availability.save({ ...saved, status: 'cancelled', cancelledAt: null }),
      ).rejects.toThrow();
    });

    it('refuses the second of two concurrent writers', async () => {
      const saved = await availability.save(record());

      const first = new PostgresAvailabilityRepository(db);
      const second = new PostgresAvailabilityRepository(db);
      const byFirst = await first.findById(saved.id);
      const bySecond = await second.findById(saved.id);

      await first.save({ ...byFirst!, description: 'Family holiday, extended' });
      await expect(
        second.save({ ...bySecond!, description: 'Cancelled by the technician' }),
      ).rejects.toBeInstanceOf(ConcurrencyError);
    });
  });
});
