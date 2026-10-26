import { z } from 'zod';
import { loadTimesheet } from '@/application/timesheets';
import { parseWith, readRoute } from '@/server/api/handler';

/**
 * `GET /api/timesheets/:userId?from=&to=` — one technician's timesheet.
 * TIMESHEET-1. The office reads anybody's; a technician reads their own. The
 * operation decides.
 */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Expected a date as YYYY-MM-DD');

export const GET = readRoute('timesheets', (context) => {
  const { from, to } = parseWith(
    z.object({ from: day, to: day }).strict(),
    Object.fromEntries(context.request.nextUrl.searchParams),
  );
  return loadTimesheet(
    { repos: context.repos, services: context.services, actor: context.actor.user },
    context.params.userId ?? '',
    from,
    to,
  );
});
