import { z } from 'zod';
import { TIMESHEET_COMMENT_LIMIT } from '@/domain';
import { saveTimesheetComment } from '@/application/timesheets';
import { writeRoute } from '@/server/api/handler';

/**
 * `POST /api/timesheets/:userId/comment` — writes, changes or clears (an empty
 * comment) the day's timesheet comment. TIMESHEET-1. The office for anybody,
 * a technician for their own days.
 */
export const POST = writeRoute({
  operation: 'timesheets.comment',
  schema: z
    .object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Expected a date as YYYY-MM-DD'),
      comment: z.string().max(TIMESHEET_COMMENT_LIMIT),
    })
    .strict(),
  handler: async (context) => ({
    comment: await saveTimesheetComment(
      context.operation,
      context.params.userId ?? '',
      context.input.date,
      context.input.comment,
    ),
  }),
});
