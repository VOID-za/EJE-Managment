import { readRoute } from '@/server/api/handler';
import { jobFormView } from '@/server/api/views';

/** Everything the New Job screen picks from. Refused for a role that cannot raise one. */
export const GET = readRoute('jobs.form', (context) =>
  jobFormView({ repos: context.repos, services: context.services, actor: context.actor.user }),
);
