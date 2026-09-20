import { readRoute } from '@/server/api/handler';
import { notificationsView } from '@/server/api/views';

/** This actor's notifications, and nobody else's. */
export const GET = readRoute('notifications.list', (context) =>
  notificationsView({
    repos: context.repos,
    services: context.services,
    actor: context.actor.user,
  }),
);
