import { z } from 'zod';
import { removeTimesheetEntry } from '@/application/timesheets';
import { writeRoute } from '@/server/api/handler';

/** `POST /api/timesheets/:userId/entries/:entryId/remove` — the owner removes one of their lines. TIMESHEET-2. */
export const POST = writeRoute({
  operation: 'timesheets.entry.remove',
  schema: z.object({}).strict(),
  handler: async (context) => {
    await removeTimesheetEntry(
      context.operation,
      context.params.userId ?? '',
      context.params.entryId ?? '',
    );
    return { removed: true };
  },
});
