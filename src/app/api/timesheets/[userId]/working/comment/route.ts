import { z } from 'zod';
import { TIMESHEET_PERIOD_COMMENT_LIMIT } from '@/domain';
import { saveWorkingTimesheetComment } from '@/application/timesheets';
import { writeRoute } from '@/server/api/handler';

/** TS-PAPER. The open sheet's one comment; submitting copies it into the snapshot. */
export const POST = writeRoute({
  operation: 'timesheets.workingComment',
  schema: z.object({ comment: z.string().max(TIMESHEET_PERIOD_COMMENT_LIMIT) }).strict(),
  handler: async (context) => saveWorkingTimesheetComment(context.operation, context.params.userId ?? '', context.input.comment),
});
