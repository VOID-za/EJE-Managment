import { z } from 'zod';
import { TIMESHEET_CUSTOMER_LIMIT, TIMESHEET_MAX_CALLOUT_CENTS, TIMESHEET_MAX_KM_PER_LINE } from '@/domain';

const hours = z.number().min(0).max(24);

/**
 * ONE TIMESHEET LINE AS A REQUEST CARRIES IT — the technician's own sheet
 * (`/entries`) and a correction of a sent one (`/period/corrections`) take the
 * same shape. The shape only: every rule is the operation's.
 */
export const timesheetLineSchema = z
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
  .strict();

/** `version` on a period read: the version in force, the original, or a correction's number. */
export const timesheetVersionParam = z
  .string()
  .regex(/^(current|original|[1-9][0-9]{0,3})$/u, 'Expected current, original or a correction number')
  .optional();

export const parseTimesheetVersion = (value: string | undefined): 'current' | 'original' | number =>
  value === undefined || value === 'current' ? 'current' : value === 'original' ? 'original' : Number(value);
