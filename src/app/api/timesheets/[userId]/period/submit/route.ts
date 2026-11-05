import { z } from 'zod';
import { refuseRetiredSubmission } from '@/application/payroll-forms';
import { writeRoute } from '@/server/api/handler';

/**
 * RETIRED (PAYROLL-ONE-1, the owner, 5 November 2026): a timesheet is no
 * longer submitted on its own from the Timesheets page. It is submitted with
 * the attendance, for the same From–To, on My Monthly Forms. Refused here,
 * whatever an old screen sends, so there is one submission point.
 */
export const POST = writeRoute({
  operation: 'timesheets.submit',
  schema: z.object({}).passthrough(),
  handler: async () => refuseRetiredSubmission('timesheet'),
});
