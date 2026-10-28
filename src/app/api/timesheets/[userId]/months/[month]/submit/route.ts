import { z } from 'zod';
import { submitTimesheetMonth } from '@/application/timesheets';
import { writeRoute } from '@/server/api/handler';

/**
 * SEND TO OFFICE (TS-02, TS-14). Once per month: a second send is refused, and
 * the month is read-only for the technician from then on.
 */
export const POST = writeRoute({
  operation: 'timesheets.submit',
  schema: z.object({}).strict(),
  handler: async (context) => ({
    month: await submitTimesheetMonth(context.operation, context.params.userId ?? '', context.params.month ?? ''),
  }),
});
