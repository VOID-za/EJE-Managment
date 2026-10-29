import { listPendingTimesheetCorrections } from '@/application/timesheet-corrections';
import { readRoute } from '@/server/api/handler';

/** `GET /api/timesheets/corrections/pending` — corrections waiting for the office (TS-16). Empty for anyone else. */
export const GET = readRoute('timesheets.corrections.pending', (context) =>
  listPendingTimesheetCorrections({ repos: context.repos, services: context.services, actor: context.actor.user }),
);
