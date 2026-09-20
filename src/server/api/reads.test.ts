import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/domain';
import type { ConversationSummary } from '@/application/chat-operations';
import { DEMO_USERS, signedInAs, startTestServer } from '@/test/api-harness';

interface MessagesScreen {
  readonly summaries: readonly ConversationSummary[];
  readonly thread: readonly ChatMessage[];
  readonly selectedId: string | null;
}

/**
 * The screen-shaped reads.
 *
 * These are composed on the SERVER, which is what lets them be actor-aware. The
 * risk that brings is that the screen and the server disagree about what is on
 * it — the case below is exactly that, and it is a bug the browser cannot fix
 * for itself.
 */
describe('the messages screen', () => {
  beforeEach(() => {
    startTestServer();
  });

  it('sends the thread the screen will open, when the URL names none', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const screen = await master.get<MessagesScreen>('/api/conversations');

    expect(screen.status).toBe(200);
    expect(screen.data.summaries.length).toBeGreaterThan(0);

    // The screen opens the first conversation; the server must have sent THAT
    // thread, or the list shows one selected and the pane beside it is empty.
    expect(screen.data.selectedId).toBe(screen.data.summaries[0]?.conversation.id);
    expect(screen.data.thread.length).toBeGreaterThan(0);
    for (const message of screen.data.thread) {
      expect(message.conversationId).toBe(screen.data.selectedId);
    }
  });

  it('sends the thread the URL asks for', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const all = await master.get<MessagesScreen>('/api/conversations');
    const wanted = all.data.summaries[all.data.summaries.length - 1]?.conversation.id ?? '';

    const screen = await master.get<MessagesScreen>(
      `/api/conversations?conversationId=${encodeURIComponent(wanted)}`,
    );

    expect(screen.data.selectedId).toBe(wanted);
    for (const message of screen.data.thread) {
      expect(message.conversationId).toBe(wanted);
    }
  });

  it('answers a conversation this actor is not in as not found', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const mine = await master.get<MessagesScreen>('/api/conversations');
    const theirs = mine.data.summaries[0]?.conversation.id ?? '';

    const technician = await signedInAs(DEMO_USERS.otherTechnician);
    const response = await technician.get(
      `/api/conversations?conversationId=${encodeURIComponent(theirs)}`,
    );

    // Not 403: refusing would confirm the conversation exists.
    expect(response.status).toBe(404);
  });

  it('refuses an unknown query parameter', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const response = await master.get('/api/conversations?actorId=somebody-else');

    expect(response.status).toBe(400);
  });
});
