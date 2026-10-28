import { z } from 'zod';
import { TIMESHEET_CUSTOMER_LIMIT, TIMESHEET_MAX_CALLOUT_CENTS, TIMESHEET_MAX_KM_PER_LINE } from '@/domain';
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
      // TS-06. Workshop instead of a customer.
      workshop: z.boolean().optional(),
      // TS-07 / TS-08: NT and the call-out COUNT are no longer entered. Accepted
      // only so a correction can carry an older line's value back unchanged;
      // the operation refuses any change to either.
      normalHours: hours.optional(),
      overtimeHours: hours,
      doubleHours: hours,
      callouts: z.number().int().min(0).max(10).optional(),
      // TS-08. The call-out in cents, and whether it is shared.
      calloutAmount: z.number().int().min(0).max(TIMESHEET_MAX_CALLOUT_CENTS).optional(),
      calloutShared: z.boolean().optional(),
      // TS-09.
      internalKm: z.number().min(0).max(TIMESHEET_MAX_KM_PER_LINE).optional(),
      customerKm: z.number().min(0).max(TIMESHEET_MAX_KM_PER_LINE).optional(),
    })
    .strict(),
  handler: async (context) => ({
    entry: await saveTimesheetEntry(context.operation, context.params.userId ?? '', context.input),
  }),
});
