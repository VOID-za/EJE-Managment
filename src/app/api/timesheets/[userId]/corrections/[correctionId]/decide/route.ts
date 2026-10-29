import { z } from 'zod';
import { TIMESHEET_CORRECTION_REASON_LIMIT } from '@/domain';
import { decideTimesheetCorrection } from '@/application/timesheet-corrections';
import { writeRoute } from '@/server/api/handler';

/**
 * THE OFFICE'S DECISION on a timesheet correction (TS-16): accept, or reject
 * with a note. Once, by a Master or Coordinator who did not ask for it.
 */
export const POST = writeRoute({
  operation: 'timesheets.correction.decide',
  schema: z
    .object({
      decision: z.enum(['accept', 'reject']),
      note: z.string().max(TIMESHEET_CORRECTION_REASON_LIMIT + 100).optional(),
    })
    .strict(),
  handler: async (context) => ({
    correction: await decideTimesheetCorrection(
      context.operation,
      context.params.userId ?? '',
      context.params.correctionId ?? '',
      context.input,
    ),
  }),
});
