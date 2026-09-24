import { beforeEach, describe, expect, it } from 'vitest';
import {
  attachAvailabilityToMessage,
  loadConversations,
  markConversationRead,
  permittedRecipients,
  sendMessage,
  startConversation,
  unreadMessageCount,
} from './chat-operations';
import { createAvailability } from './availability-operations';
import { WorkflowError } from './errors';
import { buildHarness, dayOffset, seedUser, type Harness } from './test-harness';
import { findJobAvailabilityConflicts, isMessageRead, type Conversation } from '@/domain';

/**
 * Two-way chat.
 *
 * The rule the whole feature rests on: a message is people talking. It
 * notifies the recipient and does nothing else — it cannot change a job, add a
 * job note, or make anyone unavailable. Only a Master's deliberate act does
 * that, and the record it creates stays linked to the message that prompted it.
 */
const elmarie = seedUser('user-master-elmarie');
const johan = seedUser('user-master-johan');
const sipho = seedUser('user-tech-sipho');
const yusuf = seedUser('user-tech-yusuf'); // disabled

const threadWith = async (harness: Harness, id: string): Promise<Conversation> => {
  const conversation = await harness.repos.chat.findConversation(id);
  if (conversation === null) throw new Error(`${id} is not seeded`);
  return conversation;
};

describe('who you may message', () => {
  it('lets a Master write to any active technician', async () => {
    const harness = buildHarness();
    const users = await harness.repos.users.list();
    const allowed = permittedRecipients(elmarie, users);

    expect(allowed.every((user) => user.role === 'technician')).toBe(true);
    expect(allowed.some((user) => user.id === sipho.id)).toBe(true);
  });

  it('lets a technician write to the office — Masters AND Coordinators', async () => {
    /*
     * MASTER SCOPE §3.2, §8.
     *
     * This asserted Masters only, which is what left the Coordinator — the
     * role §3.2 calls the office administrator — unable to be written to by
     * the field at all, while §8 tells technicians to "tell the office by
     * message". The office is both roles, so both are offered.
     */
    const harness = buildHarness();
    const users = await harness.repos.users.list();
    const allowed = permittedRecipients(sipho, users);

    expect(allowed.length).toBeGreaterThan(0);
    expect(allowed.every((user) => user.role === 'master' || user.role === 'coordinator')).toBe(
      true,
    );
    expect(allowed.some((user) => user.id === elmarie.id)).toBe(true);
    expect(allowed.some((user) => user.role === 'coordinator')).toBe(true);
    // And never another technician: this is the field talking to the office.
    expect(allowed.some((user) => user.role === 'technician')).toBe(false);
  });

  it('never offers a disabled account as a recipient', async () => {
    const harness = buildHarness();
    const users = await harness.repos.users.list();

    expect(yusuf.active).toBe(false);
    expect(permittedRecipients(elmarie, users).some((user) => user.id === yusuf.id)).toBe(false);
  });

  it('refuses to start a conversation with a disabled account', async () => {
    const harness = buildHarness();
    await expect(
      startConversation(harness.as(elmarie), {
        recipientIds: [yusuf.id],
        body: 'Are you there?',
      }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });
});

describe('a Master messaging a technician', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('creates the thread and the message', async () => {
    const { conversation, message } = await startConversation(harness.as(elmarie), {
      recipientIds: [sipho.id],
      body: 'Please confirm the machine serial number.',
    });

    expect(conversation.participantIds).toContain(elmarie.id);
    expect(conversation.participantIds).toContain(sipho.id);
    expect(message.body).toBe('Please confirm the machine serial number.');
    expect(message.senderId).toBe(elmarie.id);
  });

  it('notifies the technician, linking to the conversation and NOT to a job', async () => {
    const { conversation } = await startConversation(harness.as(elmarie), {
      recipientIds: [sipho.id],
      body: 'Please confirm the machine serial number.',
    });

    const notifications = await harness.repos.notifications.list(sipho.id);
    const chat = notifications.find((notification) => notification.type === 'chat_message');

    expect(chat?.title).toBe('New message from Elmarie');
    expect(chat?.link).toBe(`/messages?conversation=${conversation.id}`);
    // A chat notification that opened the job screen would be the wrong place.
    expect(chat?.jobId).toBeNull();
  });

  it('notifies nobody else', async () => {
    await startConversation(harness.as(elmarie), {
      recipientIds: [sipho.id],
      body: 'Private question.',
    });

    const johansNotifications = await harness.repos.notifications.list(johan.id);
    expect(johansNotifications.some((n) => n.type === 'chat_message')).toBe(false);
  });

  it('lets the technician reply into the same thread', async () => {
    const { conversation } = await startConversation(harness.as(elmarie), {
      recipientIds: [sipho.id],
      body: 'Please confirm the machine serial number.',
    });

    await sendMessage(harness.as(sipho), conversation, 'Confirmed. Serial number is ABC123.');

    const messages = await harness.repos.chat.listMessages(conversation.id);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.senderId).toBe(elmarie.id);
    expect(messages[1]?.senderId).toBe(sipho.id);
    expect(messages[1]?.body).toBe('Confirmed. Serial number is ABC123.');
  });

  it('notifies the Master of the reply', async () => {
    const { conversation } = await startConversation(harness.as(elmarie), {
      recipientIds: [sipho.id],
      body: 'Question?',
    });
    await sendMessage(harness.as(sipho), conversation, 'Answer.');

    const notifications = await harness.repos.notifications.list(elmarie.id);
    expect(notifications.some((n) => n.type === 'chat_message' && n.title.includes('Sipho'))).toBe(
      true,
    );
  });

  it('keeps a second message about the same thing in one thread', async () => {
    const first = await startConversation(harness.as(elmarie), {
      recipientIds: [sipho.id],
      body: 'One.',
    });
    const second = await startConversation(harness.as(elmarie), {
      recipientIds: [sipho.id],
      body: 'Two.',
    });

    expect(second.conversation.id).toBe(first.conversation.id);
    expect(await harness.repos.chat.listMessages(first.conversation.id)).toHaveLength(2);
  });

  it('links a conversation to a job so it can be opened from there', async () => {
    const job = await harness.repos.jobs.findByJobNumber('EJE-1048');
    const { conversation } = await startConversation(harness.as(elmarie), {
      recipientIds: [sipho.id],
      body: 'About this one.',
      job: { id: job!.id, jobNumber: job!.jobNumber },
    });

    expect(conversation.jobId).toBe(job!.id);
    expect(conversation.jobNumber).toBe('EJE-1048');
  });

  it('refuses an empty message', async () => {
    await expect(
      startConversation(harness.as(elmarie), { recipientIds: [sipho.id], body: '   ' }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('refuses a message into a thread the sender is not in', async () => {
    const { conversation } = await startConversation(harness.as(elmarie), {
      recipientIds: [sipho.id],
      body: 'Private.',
    });
    const riaan = seedUser('user-tech-riaan');

    await expect(
      sendMessage(harness.as(riaan), conversation, 'Reading your mail.'),
    ).rejects.toBeInstanceOf(WorkflowError);
  });
});

describe('a technician messaging the office', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('reaches every active Master, so whoever is at a desk can pick it up', async () => {
    const { conversation } = await startConversation(harness.as(sipho), {
      recipientIds: [],
      body: 'Running late on the N1.',
    });

    const users = await harness.repos.users.list();
    const masters = users.filter((user) => user.role === 'master' && user.active);
    for (const master of masters) {
      expect(conversation.participantIds).toContain(master.id);
      const notifications = await harness.repos.notifications.list(master.id);
      expect(notifications.some((n) => n.type === 'chat_message')).toBe(true);
    }
  });
});

describe('unread state', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('counts messages the user has not read', async () => {
    const before = await unreadMessageCount(harness.as(sipho), sipho.id);
    await startConversation(harness.as(elmarie), {
      recipientIds: [sipho.id],
      body: 'One.',
    });
    expect(await unreadMessageCount(harness.as(sipho), sipho.id)).toBe(before + 1);
  });

  it('never counts your own messages against you', async () => {
    const before = await unreadMessageCount(harness.as(elmarie), elmarie.id);
    await startConversation(harness.as(elmarie), {
      recipientIds: [sipho.id],
      body: 'Mine.',
    });
    expect(await unreadMessageCount(harness.as(elmarie), elmarie.id)).toBe(before);
  });

  it('clears when the conversation is read', async () => {
    const { conversation } = await startConversation(harness.as(elmarie), {
      recipientIds: [sipho.id],
      body: 'Read me.',
    });

    const cleared = await markConversationRead(harness.as(sipho), conversation);
    expect(cleared).toBe(1);

    const messages = await harness.repos.chat.listMessages(conversation.id);
    expect(messages.every((message) => isMessageRead(message, sipho.id))).toBe(true);
  });

  it('clears the matching chat notification too', async () => {
    const { conversation } = await startConversation(harness.as(elmarie), {
      recipientIds: [sipho.id],
      body: 'Read me.',
    });
    await markConversationRead(harness.as(sipho), conversation);

    const notifications = await harness.repos.notifications.list(sipho.id);
    const chat = notifications.filter((n) => n.type === 'chat_message');
    expect(chat.length).toBeGreaterThan(0);
    expect(chat.every((n) => n.readAt !== null)).toBe(true);
  });

  it('is reported per conversation in the list', async () => {
    await startConversation(harness.as(elmarie), { recipientIds: [sipho.id], body: 'A.' });
    const summaries = await loadConversations(harness.as(sipho));
    const mine = summaries.find((summary) =>
      summary.conversation.participantIds.includes(elmarie.id),
    );

    expect(mine?.unread).toBe(1);
    expect(mine?.lastMessage?.body).toBe('A.');
  });

  it('reading one conversation leaves another unread', async () => {
    const first = await startConversation(harness.as(elmarie), {
      recipientIds: [sipho.id],
      body: 'First.',
    });
    await startConversation(harness.as(johan), { recipientIds: [sipho.id], body: 'Second.' });

    await markConversationRead(harness.as(sipho), first.conversation);
    expect(await unreadMessageCount(harness.as(sipho), sipho.id)).toBeGreaterThan(0);
  });
});

describe('chat changes nothing else', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('does not touch the job it is about', async () => {
    const before = await harness.repos.jobs.findByJobNumber('EJE-1048');
    await startConversation(harness.as(elmarie), {
      recipientIds: [sipho.id],
      body: 'About EJE-1048.',
      job: { id: before!.id, jobNumber: before!.jobNumber },
    });

    const after = await harness.repos.jobs.findByJobNumber('EJE-1048');
    expect(after?.status).toBe(before?.status);
    expect(after?.notes).toHaveLength(before!.notes.length);
    expect(after?.primaryTechnicianId).toBe(before?.primaryTechnicianId);
  });

  it('does not add a job note', async () => {
    const before = await harness.repos.jobs.findByJobNumber('EJE-1048');
    await startConversation(harness.as(sipho), {
      recipientIds: [],
      body: 'This should not become a job note.',
      job: { id: before!.id, jobNumber: before!.jobNumber },
    });

    const after = await harness.repos.jobs.findByJobNumber('EJE-1048');
    expect(after?.notes.map((note) => note.body)).not.toContain(
      'This should not become a job note.',
    );
  });

  it('does not make the sender unavailable', async () => {
    await startConversation(harness.as(sipho), {
      recipientIds: [],
      body: "Doctor's appointment at 9, back by 11.",
    });

    const records = await harness.repos.availability.listForUser(sipho.id);
    const today = records.filter(
      (record) => record.startDate <= dayOffset(0) && record.endDate >= dayOffset(0),
    );
    expect(today).toHaveLength(0);
  });
});

describe('a Master acting on a message', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('links the availability record back to the message', async () => {
    const { conversation, message } = await startConversation(harness.as(sipho), {
      recipientIds: [],
      body: "Doctor's appointment at 9, back by 11.",
    });

    const { record } = await createAvailability(harness.as(elmarie), {
      userId: sipho.id,
      type: 'appointment',
      startDate: dayOffset(0),
      endDate: dayOffset(0),
      allDay: false,
      startTime: '09:00',
      endTime: '11:00',
      description: "Doctor's appointment.",
    });
    const actioned = await attachAvailabilityToMessage(harness.as(elmarie), message, record);

    expect(actioned.availabilityRecordId).toBe(record.id);
    expect(actioned.actionedBy).toBe(elmarie.id);

    // Only now does it block work.
    expect(
      findJobAvailabilityConflicts([record], sipho.id, {
        scheduledDate: dayOffset(0),
        scheduledEndDate: null,
        jobType: 'breakdown',
      }),
    ).toHaveLength(1);

    const stored = await harness.repos.chat.listMessages(conversation.id);
    expect(stored[0]?.availabilityRecordId).toBe(record.id);
  });

  it('writes it to the audit trail', async () => {
    const { message } = await startConversation(harness.as(sipho), {
      recipientIds: [],
      body: 'Appointment at 9.',
    });
    const { record } = await createAvailability(harness.as(elmarie), {
      userId: sipho.id,
      type: 'appointment',
      startDate: dayOffset(0),
      endDate: dayOffset(0),
      allDay: true,
      startTime: null,
      endTime: null,
      description: '',
    });
    await attachAvailabilityToMessage(harness.as(elmarie), message, record);

    const trail = await harness.repos.activity.list();
    const entry = trail.find((event) => event.type === 'message_actioned');
    expect(entry?.summary).toContain('Availability recorded');
  });
});

describe('historical conversations', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('survive from the one-way message board, with their availability links', async () => {
    const thread = await threadWith(harness, 'conv-lerato-office');
    const messages = await harness.repos.chat.listMessages(thread.id);

    const actioned = messages.find((message) => message.availabilityRecordId !== null);
    expect(actioned).toBeDefined();

    const linked = await harness.repos.availability.findById(actioned!.availabilityRecordId!);
    expect(linked).not.toBeNull();
  });

  it('are two-way, with replies from the office', async () => {
    const thread = await threadWith(harness, 'conv-francois-office');
    const messages = await harness.repos.chat.listMessages(thread.id);

    expect(messages.some((message) => message.senderId === seedUser('user-tech-francois').id)).toBe(
      true,
    );
    expect(messages.some((message) => message.senderId === johan.id)).toBe(true);
  });

  it('remain readable after a participant is disabled', async () => {
    const thread = await threadWith(harness, 'conv-elmarie-sipho-1048');
    await harness.repos.users.save({ ...sipho, active: false });

    // The thread is untouched: disabling someone is not a reason to lose what
    // was said.
    const messages = await harness.repos.chat.listMessages(thread.id);
    expect(messages.length).toBeGreaterThan(1);
    expect((await loadConversations(harness.as(elmarie))).some((s) => s.conversation.id === thread.id)).toBe(
      true,
    );
  });
});

describe('thread ordering', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('never moves a thread backwards in the list when somebody replies', async () => {
    // A thread can legitimately hold a message stamped later than now — seeded
    // demonstration data did, when the demo was opened early enough in the day.
    // Replying to it must not drop it below older threads, which is what sent
    // the Messages screen to the wrong conversation.
    const conversations = await harness.repos.chat.listConversations(
      seedUser('user-master-elmarie').id,
    );
    const thread = conversations[0]!;
    const future = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    await harness.repos.chat.saveConversation({ ...thread, lastMessageAt: future });

    const stamped = (await harness.repos.chat.findConversation(thread.id))!;
    const result = await sendMessage(
      harness.as(seedUser('user-master-elmarie')),
      stamped,
      'Replying to a thread whose last message is in the future.',
    );

    expect(result.conversation.lastMessageAt).toBe(future);
    // Still the most recent thread, so the screen still opens it.
    const reordered = await harness.repos.chat.listConversations(
      seedUser('user-master-elmarie').id,
    );
    expect(reordered[0]?.id).toBe(thread.id);
  });

  it('seeds no conversation whose last message is in the future', async () => {
    const now = new Date().toISOString();
    for (const conversation of await harness.repos.chat.listConversations(
      seedUser('user-master-elmarie').id,
    )) {
      expect(conversation.lastMessageAt <= now, conversation.id).toBe(true);
      expect(conversation.createdAt <= now, conversation.id).toBe(true);
    }
    for (const message of await harness.repos.chat.listMessages('conv-lerato-office')) {
      expect(message.sentAt <= now, message.id).toBe(true);
    }
  });
});
