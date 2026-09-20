import { readRoute } from '@/server/api/handler';
import { adminView } from '@/server/api/views';

/** Administration. Refused server-side for a role without `admin.access`. */
export const GET = readRoute('admin', (context) =>
  adminView({ repos: context.repos, services: context.services, actor: context.actor.user }),
);
