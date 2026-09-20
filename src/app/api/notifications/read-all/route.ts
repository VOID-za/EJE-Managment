import { z } from 'zod';
import { writeRoute } from '@/server/api/handler';
import { runMarkAllNotificationsRead } from '@/server/api/commands/office';

export const POST = writeRoute({
  operation: 'notifications.read_all',
  schema: z.object({}).strict(),
  handler: (context) =>
    runMarkAllNotificationsRead({
      repos: context.repos,
      services: context.services,
      actor: context.actor.user,
      operation: context.operation,
    }),
});
