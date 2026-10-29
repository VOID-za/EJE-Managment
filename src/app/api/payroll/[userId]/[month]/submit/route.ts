import { z } from 'zod';
import { submitMonth } from '@/application/monthly-submissions';
import { writeRoute } from '@/server/api/handler';

/**
 * SUBMIT THE MONTH (PAY-02): the timesheet and the attendance together, once.
 * The technician's own; `confirmUnrecorded` when weekdays have no attendance.
 */
export const POST = writeRoute({
  operation: 'payroll.month.submit',
  schema: z.object({ confirmUnrecorded: z.boolean().optional() }).strict(),
  handler: async (context) => ({
    submission: await submitMonth(context.operation, context.params.userId ?? '', context.params.month ?? '', context.input),
  }),
});
