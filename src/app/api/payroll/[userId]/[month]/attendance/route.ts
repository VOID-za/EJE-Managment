import { z } from 'zod';
import { loadAttendanceDocument } from '@/application/attendance-document';
import { parseWith, readRoute } from '@/server/api/handler';

/** The month's attendance form (PAY-01): 'current' (in force) or 'submitted' (exactly as submitted). */
export const GET = readRoute('payroll.month.attendance', (context) => {
  const { version } = parseWith(
    z.object({ version: z.enum(['current', 'submitted']).optional() }).strict(),
    Object.fromEntries(context.request.nextUrl.searchParams),
  );
  return loadAttendanceDocument({ repos: context.repos, services: context.services, actor: context.actor.user }, context.params.userId ?? '', context.params.month ?? '', version ?? 'current');
});
