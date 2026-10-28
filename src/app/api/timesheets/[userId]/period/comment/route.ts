import { z } from 'zod';
import { TIMESHEET_PERIOD_COMMENT_LIMIT } from '@/domain';
import { saveTimesheetPeriodComment } from '@/application/timesheets';
import { writeRoute } from '@/server/api/handler';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Expected a date as YYYY-MM-DD');

/** SAVE: the one comment for the chosen period (TS-10, TS-12). Never a submission. */
export const POST = writeRoute({
  operation: 'timesheets.periodComment',
  schema: z.object({ from: day, to: day, comment: z.string().max(TIMESHEET_PERIOD_COMMENT_LIMIT) }).strict(),
  handler: async (context) => ({
    period: await saveTimesheetPeriodComment(
      context.operation,
      context.params.userId ?? '',
      context.input.from,
      context.input.to,
      context.input.comment,
    ),
  }),
});
