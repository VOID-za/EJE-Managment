import { z } from 'zod';
import { ATTENDANCE_NOTE_LIMIT } from '@/domain';
import { loadAttendanceRegister, recordAttendance } from '@/application/attendance-operations';
import { parseWith, readRoute, writeRoute } from '@/server/api/handler';

/**
 * THE ATTENDANCE REGISTER. ATTEND-1.
 *
 * `GET /api/attendance?date=YYYY-MM-DD` — everybody on the system and what is
 * recorded for them that day, with any planned leave beside them.
 * `POST /api/attendance` — record or correct one person's day.
 *
 * Both are the office's (`attendance.manage`); the operation decides, so a
 * technician calling either directly is refused there.
 */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Expected a date as YYYY-MM-DD');

export const GET = readRoute('attendance', (context) => {
  const { date } = parseWith(
    z.object({ date: day }).strict(),
    Object.fromEntries(context.request.nextUrl.searchParams),
  );
  return loadAttendanceRegister(
    { repos: context.repos, services: context.services, actor: context.actor.user },
    date,
  );
});

export const POST = writeRoute({
  operation: 'attendance.record',
  schema: z
    .object({
      userId: z.string().min(1).max(100),
      date: day,
      status: z.enum(['present', 'absent']),
      // ATT-01. Its value is the operation's rule (four reasons, absent only).
      absenceReason: z.string().max(40).nullable().optional(),
      note: z.string().max(ATTENDANCE_NOTE_LIMIT).default(''),
    })
    .strict(),
  handler: (context) => recordAttendance(context.operation, context.input),
});
