import { z } from 'zod';
import { TIMESHEET_CUSTOMER_LIMIT } from '@/domain';
import { saveTimesheetEntry } from '@/application/timesheets';
import { writeRoute } from '@/server/api/handler';

/**
 * `POST /api/timesheets/:userId/entries` — adds a line to the technician's own
 * timesheet, or corrects one (with `entryId`). TIMESHEET-2: every value typed
 * by the technician; only the owner may write (the operation refuses anybody
 * else, the office included).
 */
const hours = z.number().min(0).max(24);

export const POST = writeRoute({
  operation: 'timesheets.entry',
  schema: z
    .object({
      entryId: z.string().min(1).max(100).optional(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Expected a date as YYYY-MM-DD'),
      customerId: z.string().min(1).max(100).nullable().optional(),
      customerName: z.string().max(TIMESHEET_CUSTOMER_LIMIT),
      normalHours: hours,
      overtimeHours: hours,
      doubleHours: hours,
      callouts: z.number().int().min(0).max(10),
    })
    .strict(),
  handler: async (context) => ({
    entry: await saveTimesheetEntry(context.operation, context.params.userId ?? '', context.input),
  }),
});
