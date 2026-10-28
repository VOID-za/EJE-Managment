import { loadTimesheetDocument } from '@/application/timesheets';
import { readRoute } from '@/server/api/handler';

/**
 * One month's timesheet as its PDF Layout prints it (TS-11, PDF-01). The
 * screen draws the same document from this on a browser with no PDF viewer.
 * A read: opening it never submits, locks or writes anything.
 */
export const GET = readRoute('timesheets.month', (context) =>
  loadTimesheetDocument(
    { repos: context.repos, services: context.services, actor: context.actor.user },
    context.params.userId ?? '',
    context.params.month ?? '',
  ),
);
