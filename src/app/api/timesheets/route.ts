import { listTimesheetPeople } from '@/application/timesheets';
import { readRoute } from '@/server/api/handler';

/** `GET /api/timesheets` — whose timesheets the caller may open. TIMESHEET-1. */
export const GET = readRoute('timesheets', (context) =>
  listTimesheetPeople({ repos: context.repos, services: context.services, actor: context.actor.user }),
);
