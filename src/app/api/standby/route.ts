import { z } from 'zod';
import { loadStandbyCalendar } from '@/application/standby';
import { parseWith, readRoute } from '@/server/api/handler';

const range = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();

/**
 * `GET /api/standby?from=&to=` — the standby calendar (STANDBY-2). Published
 * weeks for everybody; drafts and each week's warnings for the office only.
 */
export const GET = readRoute('standby', (context) => {
  const { from, to } = parseWith(range, Object.fromEntries(context.request.nextUrl.searchParams));
  return loadStandbyCalendar({ repos: context.repos, services: context.services, actor: context.actor.user }, from, to);
});
