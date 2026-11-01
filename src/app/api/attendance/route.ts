import { z } from 'zod';
import { ATTENDANCE_NOTE_LIMIT } from '@/domain';
import { recordAttendance } from '@/application/attendance-operations';
import { writeRoute } from '@/server/api/handler';

/**
 * `POST /api/attendance` — record or correct ONE OF YOUR OWN days. ATTEND-2,
 * ATT-OWN-1 (1 November 2026).
 *
 * Every role records its own days and nobody else's; the operation refuses
 * another person's `userId`, whoever asks. The office's Team register — the
 * `GET` that listed everybody for a day so it could record them — was
 * withdrawn with it; the office reads everybody's attendance on EJE Monthly
 * Forms.
 */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Expected a date as YYYY-MM-DD');

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
      // ATT-AUTO-1: the record the screen was looking at, so a stale autosave is refused.
      expectedRecordedAt: z.string().max(40).nullable().optional(),
    })
    .strict(),
  handler: (context) => recordAttendance(context.operation, context.input),
});
