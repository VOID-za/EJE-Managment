import { z } from 'zod';
import { submitTimesheetPeriod } from '@/application/timesheets';
import { writeRoute } from '@/server/api/handler';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Expected a date as YYYY-MM-DD');

/**
 * SEND TO OFFICE for the chosen period (TS-02, TS-14). Once: a second send, or
 * a period sharing a day with one already sent, is refused; the office is
 * notified only when the submission has been saved.
 */
export const POST = writeRoute({
  operation: 'timesheets.submit',
  schema: z.object({ from: day, to: day }).strict(),
  handler: async (context) => ({
    period: await submitTimesheetPeriod(
      context.operation,
      context.params.userId ?? '',
      context.input.from,
      context.input.to,
    ),
  }),
});
