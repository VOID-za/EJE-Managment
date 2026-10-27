import { z } from 'zod';
import { loadMyAttendance } from '@/application/attendance-operations';
import { parseWith, readRoute } from '@/server/api/handler';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Expected a date as YYYY-MM-DD');

/** `GET /api/attendance/mine?from&to` — the signed-in person's own days, recorded or not. ATTEND-2. */
export const GET = readRoute('attendance.mine', (context) => {
  const query = parseWith(
    z.object({ from: day, to: day }).strict(),
    Object.fromEntries(context.request.nextUrl.searchParams),
  );
  return loadMyAttendance(
    { repos: context.repos, services: context.services, actor: context.actor.user },
    query.from,
    query.to,
  );
});
