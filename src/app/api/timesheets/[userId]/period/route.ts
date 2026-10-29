import { z } from 'zod';
import { loadTimesheetDocument } from '@/application/timesheets';
import { parseWith, readRoute } from '@/server/api/handler';
import { parseTimesheetVersion, timesheetVersionParam } from '@/server/api/timesheet-line';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Expected a date as YYYY-MM-DD');

/**
 * One chosen period's timesheet as its PDF Layout prints it (TS-11, PDF-01).
 * The screen draws the same document from this on a browser with no PDF
 * viewer. A read: opening it never submits, locks or writes anything.
 */
export const GET = readRoute('timesheets.period', (context) => {
  const { from, to, version } = parseWith(
    z.object({ from: day, to: day, version: timesheetVersionParam }).strict(),
    Object.fromEntries(context.request.nextUrl.searchParams),
  );
  return loadTimesheetDocument(
    { repos: context.repos, services: context.services, actor: context.actor.user },
    context.params.userId ?? '',
    from,
    to,
    parseTimesheetVersion(version),
  );
});
