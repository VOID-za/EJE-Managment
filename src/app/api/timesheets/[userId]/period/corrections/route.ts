import { z } from 'zod';
import { TIMESHEET_CORRECTION_MAX_LINES, TIMESHEET_CORRECTION_REASON_LIMIT, TIMESHEET_PERIOD_COMMENT_LIMIT } from '@/domain';
import { requestTimesheetCorrection } from '@/application/timesheet-corrections';
import { writeRoute } from '@/server/api/handler';
import { timesheetLineSchema } from '@/server/api/timesheet-line';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Expected a date as YYYY-MM-DD');

/**
 * ASK TO CORRECT A SENT TIMESHEET (TS-16): the reason and the complete
 * corrected period. The technician's own only; the office decides. The sent
 * timesheet itself is never changed.
 */
export const POST = writeRoute({
  operation: 'timesheets.correction.request',
  schema: z
    .object({
      from: day,
      to: day,
      // REPEAT-DATES-1: the very submission corrected (several may share the dates).
      periodId: z.string().min(1).max(100).optional(),
      reason: z.string().max(TIMESHEET_CORRECTION_REASON_LIMIT + 100),
      comment: z.string().max(TIMESHEET_PERIOD_COMMENT_LIMIT + 100),
      lines: z.array(timesheetLineSchema).max(TIMESHEET_CORRECTION_MAX_LINES),
    })
    .strict(),
  handler: async (context) => ({
    correction: await requestTimesheetCorrection(context.operation, context.params.userId ?? '', context.input),
  }),
});
