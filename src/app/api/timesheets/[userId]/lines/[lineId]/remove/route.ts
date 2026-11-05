import { z } from 'zod';
import { removeTimesheetLine } from '@/application/timesheet-lines';
import { writeRoute } from '@/server/api/handler';

/** REMOVE ONE LINE and any draft of it (PAYROLL-ONE-1). The owner only; asked again, it changes nothing. */
export const POST = writeRoute({
  operation: 'timesheets.line.remove',
  schema: z.object({}).strict(),
  handler: async (context) => removeTimesheetLine(context.operation, context.params.userId ?? '', context.params.lineId ?? ''),
});
