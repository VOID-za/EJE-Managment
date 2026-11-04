import { z } from 'zod';
import { loadSubmissionDocument } from '@/application/timesheets';
import { parseWith, readRoute } from '@/server/api/handler';
import { parseTimesheetVersion, timesheetVersionParam } from '@/server/api/timesheet-line';

/** TS-PAPER. One submission as its PDF Layout prints it — the version in force, the original, or a correction. */
export const GET = readRoute('timesheets.submission', (context) => {
  const { version } = parseWith(
    z.object({ version: timesheetVersionParam }).strict(),
    Object.fromEntries(context.request.nextUrl.searchParams),
  );
  return loadSubmissionDocument(
    { repos: context.repos, services: context.services, actor: context.actor.user },
    context.params.periodId ?? '',
    parseTimesheetVersion(version),
  );
});
