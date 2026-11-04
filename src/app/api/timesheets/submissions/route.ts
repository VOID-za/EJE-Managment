import { z } from 'zod';
import { listTimesheetSubmissions } from '@/application/timesheets';
import { parseWith, readRoute } from '@/server/api/handler';

/** TS-PAPER. Submitted timesheets, the latest first: the office's are everybody's (or one person's); anybody else's their own. */
export const GET = readRoute('timesheets.submissions', (context) => {
  const { userId } = parseWith(
    z.object({ userId: z.string().min(1).max(100).optional() }).strict(),
    Object.fromEntries(context.request.nextUrl.searchParams),
  );
  return listTimesheetSubmissions({ repos: context.repos, services: context.services, actor: context.actor.user }, userId);
});
