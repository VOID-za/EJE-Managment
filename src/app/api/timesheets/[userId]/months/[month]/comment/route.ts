import { z } from 'zod';
import { TIMESHEET_MONTH_COMMENT_LIMIT } from '@/domain';
import { saveTimesheetMonthComment } from '@/application/timesheets';
import { writeRoute } from '@/server/api/handler';

/** SAVE: the one comment for the whole timesheet (TS-10, TS-12). Never a submission. */
export const POST = writeRoute({
  operation: 'timesheets.monthComment',
  schema: z.object({ comment: z.string().max(TIMESHEET_MONTH_COMMENT_LIMIT) }).strict(),
  handler: async (context) => ({
    month: await saveTimesheetMonthComment(
      context.operation,
      context.params.userId ?? '',
      context.params.month ?? '',
      context.input.comment,
    ),
  }),
});
