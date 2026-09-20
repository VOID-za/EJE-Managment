import { z } from 'zod';
import { parseWith, readRoute } from '@/server/api/handler';
import { calendarView } from '@/server/api/views';

const range = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();

export const GET = readRoute('calendar', (context) => {
  const { from, to } = parseWith(range, Object.fromEntries(context.request.nextUrl.searchParams));
  return calendarView(
    { repos: context.repos, services: context.services, actor: context.actor.user },
    from,
    to,
  );
});
