import { z } from 'zod';
import { refuseRetiredSubmission } from '@/application/payroll-forms';
import { writeRoute } from '@/server/api/handler';

/**
 * RETIRED (PAYROLL-ONE-1, the owner, 5 November 2026): a calendar month is no
 * longer submitted, and a submission is never rewritten in place. The forms
 * are submitted together for the real From–To on My Monthly Forms. The months
 * already submitted stay, readable, exactly as they were.
 */
export const POST = writeRoute({
  operation: 'payroll.month.submit',
  schema: z.object({}).passthrough(),
  handler: async () => refuseRetiredSubmission('month'),
});
