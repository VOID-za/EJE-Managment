import { loadWorkingTimesheet } from '@/application/timesheets';
import { readRoute } from '@/server/api/handler';

/** TS-PAPER. The open sheet: every line not yet submitted, its comment, and the dates Submit proposes. */
export const GET = readRoute('timesheets.working', (context) =>
  loadWorkingTimesheet({ repos: context.repos, services: context.services, actor: context.actor.user }, context.params.userId ?? ''),
);
