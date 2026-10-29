import { saveTimesheetEntry } from '@/application/timesheets';
import { writeRoute } from '@/server/api/handler';
import { timesheetLineSchema } from '@/server/api/timesheet-line';

/**
 * `POST /api/timesheets/:userId/entries` — adds a line to the technician's own
 * timesheet, or corrects one (with `entryId`). TIMESHEET-2: every value typed
 * by the technician; only the owner may write (the operation refuses anybody
 * else, the office included).
 */
export const POST = writeRoute({
  operation: 'timesheets.entry',
  schema: timesheetLineSchema,
  handler: async (context) => ({
    entry: await saveTimesheetEntry(context.operation, context.params.userId ?? '', context.input),
  }),
});
