import { readRoute } from '@/server/api/handler';
import { shellView } from '@/server/api/views';

/** The two badges the application shell carries: unread notifications and messages. */
export const GET = readRoute('shell', (context) =>
  shellView({ repos: context.repos, services: context.services, actor: context.actor.user }),
);
