import { beforeEach, describe, expect, it } from 'vitest';
import type { ConversationSummary } from '@/application/chat-operations';
import { DEMO_USERS, signedInAs, startTestServer, type ApiTestClient } from '@/test/api-harness';

/**
 * CHAT-DELETE-1 and NOTIF-AUDIT-1, over HTTP. Deleting a chat is a
 * participant's act checked on the server; afterwards the shell's Messages
 * badge and the Messages screen agree, and the other participant still has
 * the chat.
 */
interface MessagesScreen {
  readonly summaries: readonly ConversationSummary[];
}
interface ShellBody {
  readonly unreadNotifications: number;
  readonly unreadMessages: number;
}

let master: ApiTestClient;
let sipho: ApiTestClient;
let riaan: ApiTestClient;

beforeEach(async () => {
  startTestServer();
  master = await signedInAs(DEMO_USERS.master);
  sipho = await signedInAs(DEMO_USERS.technician);
  riaan = await signedInAs(DEMO_USERS.otherTechnician);
});

const siphoId = async (): Promise<string> =>
  (await sipho.get<{ user: { id: string } }>('/api/auth/me')).data.user.id;

describe('deleting a chat over the API', () => {
  it('is refused to a non-participant, and the badge follows a participant’s deletion', async () => {
    const started = await master.post<{ conversation: { id: string } }>('/api/conversations', {
      recipientIds: [await siphoId()],
      body: 'Please confirm the serial number.',
    });
    expect(started.status).toBeLessThan(300);
    const id = started.data.conversation.id;

    const before = (await sipho.get<ShellBody>('/api/shell')).data;
    expect(before.unreadMessages).toBeGreaterThan(0);

    // Somebody not in the chat cannot delete it (the server does not even admit it exists).
    const stranger = await riaan.post(`/api/conversations/${id}/delete_for_me`, {});
    expect(stranger.status).toBeGreaterThanOrEqual(400);

    const deleted = await sipho.post(`/api/conversations/${id}/delete_for_me`, {});
    expect(deleted.status).toBe(200);

    const after = (await sipho.get<ShellBody>('/api/shell')).data;
    const screen = (await sipho.get<MessagesScreen>('/api/conversations')).data;
    expect(screen.summaries.some((summary) => summary.conversation.id === id)).toBe(false);
    expect(after.unreadMessages).toBe(screen.summaries.reduce((sum, summary) => sum + summary.unread, 0));
    expect(after.unreadNotifications).toBeLessThan(before.unreadNotifications);

    const theirs = (await master.get<MessagesScreen>('/api/conversations')).data;
    expect(theirs.summaries.some((summary) => summary.conversation.id === id)).toBe(true);
  });
});
