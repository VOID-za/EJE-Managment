import { describe, expect, it } from 'vitest';
import {
  deleteConversationForMe,
  loadConversations,
  sendMessage,
  startConversation,
  unreadMessageCount,
} from './chat-operations';
import { buildHarness, seedUser } from './test-harness';

/**
 * CHAT-DELETE-1 (the owner's instruction of 27 October 2026). Deleting a chat
 * takes it off THAT person's list only; the other participants keep it; every
 * message is retained; only a participant may do it (on the server); it is
 * audited; and a message sent afterwards brings it back showing only what came
 * after.
 */
const elmarie = seedUser('user-master-elmarie');
const sipho = seedUser('user-tech-sipho');
const riaan = seedUser('user-tech-riaan');
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('deleting a chat', () => {
  it('removes it from my list only; the other participant keeps it; nothing is erased; audited', async () => {
    const harness = buildHarness();
    const { conversation } = await startConversation(harness.as(elmarie), {
      recipientIds: [sipho.id],
      body: 'Please confirm the serial number.',
    });
    const before = await harness.repos.chat.listMessages(conversation.id);

    await deleteConversationForMe(harness.as(sipho), conversation);

    const mine = await loadConversations(harness.as(sipho));
    expect(mine.some((summary) => summary.conversation.id === conversation.id)).toBe(false);
    const theirs = await loadConversations(harness.as(elmarie));
    expect(theirs.find((summary) => summary.conversation.id === conversation.id)?.total).toBe(1);
    expect(await harness.repos.chat.listMessages(conversation.id)).toEqual(before);
    expect(await unreadMessageCount(harness.as(sipho), sipho.id)).toBe(
      (await loadConversations(harness.as(sipho))).reduce((sum, summary) => sum + summary.unread, 0),
    );
    const trail = await harness.repos.activity.list();
    expect(trail.some((event) => event.type === 'conversation_deleted')).toBe(true);
  });

  it('marks the chat’s notifications read, so the bell stops counting it', async () => {
    const harness = buildHarness();
    const { conversation } = await startConversation(harness.as(elmarie), {
      recipientIds: [sipho.id],
      body: 'Call me.',
    });
    await deleteConversationForMe(harness.as(sipho), conversation);
    const unread = (await harness.repos.notifications.list(sipho.id)).filter(
      (notification) =>
        notification.link === `/messages?conversation=${conversation.id}` && notification.readAt === null,
    );
    expect(unread).toHaveLength(0);
  });

  it('comes back when somebody writes again, showing only the new messages', async () => {
    const harness = buildHarness();
    const { conversation } = await startConversation(harness.as(elmarie), {
      recipientIds: [sipho.id],
      body: 'First.',
    });
    await deleteConversationForMe(harness.as(sipho), conversation);
    await tick();
    const fresh = await harness.repos.chat.findConversation(conversation.id);
    await sendMessage(harness.as(elmarie), fresh!, 'Second.');

    const mine = await loadConversations(harness.as(sipho));
    const back = mine.find((summary) => summary.conversation.id === conversation.id);
    expect(back?.total).toBe(1);
    expect(back?.lastMessage?.body).toBe('Second.');
  });

  it('is refused to somebody who is not in the chat', async () => {
    const harness = buildHarness();
    const { conversation } = await startConversation(harness.as(elmarie), {
      recipientIds: [sipho.id],
      body: 'Private.',
    });
    await expect(deleteConversationForMe(harness.as(riaan), conversation)).rejects.toMatchObject({
      violations: [{ code: 'not_a_participant' }],
    });
    expect((await loadConversations(harness.as(sipho))).some((s) => s.conversation.id === conversation.id)).toBe(true);
  });
});
