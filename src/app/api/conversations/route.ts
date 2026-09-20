import { z } from 'zod';
import { parseWith, readRoute, writeRoute } from '@/server/api/handler';
import {
  runStartConversation,
  startConversationSchema,
} from '@/server/api/commands/office';
import { messagesView } from '@/server/api/views';

const query = z.object({ conversationId: z.string().max(100).optional() }).strict();

/**
 * This actor's threads, and one thread's messages.
 *
 * The thread is only served to somebody in it — `messagesView` checks that the
 * conversation is among this actor's own, and answers not found otherwise.
 */
export const GET = readRoute('conversations.list', (context) => {
  const { conversationId } = parseWith(
    query,
    Object.fromEntries(context.request.nextUrl.searchParams),
  );
  return messagesView(
    { repos: context.repos, services: context.services, actor: context.actor.user },
    conversationId ?? null,
  );
});

export const POST = writeRoute({
  operation: 'conversations.start',
  schema: startConversationSchema,
  handler: (context) =>
    runStartConversation(
      {
        repos: context.repos,
        services: context.services,
        actor: context.actor.user,
        operation: context.operation,
      },
      context.input,
    ),
});
