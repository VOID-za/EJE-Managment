import { z } from 'zod';
import { submitPayrollForms } from '@/application/payroll-forms';
import { writeRoute } from '@/server/api/handler';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Expected a date as YYYY-MM-DD');

/**
 * SUBMIT BOTH FORMS TOGETHER (PAYROLL-ONE-1): the timesheet and the
 * attendance for exactly From–To, in one transaction, once. The person's own.
 * `revision` is what the screen reviewed; the confirmations are explicit.
 */
export const POST = writeRoute({
  operation: 'payroll.forms.submit',
  schema: z
    .object({
      from: day,
      to: day,
      revision: z.string().min(1).max(200),
      confirmUnrecorded: z.boolean().optional(),
      confirmNoLines: z.boolean().optional(),
      confirmReplace: z.boolean().optional(),
    })
    .strict(),
  handler: async (context) => {
    const submission = await submitPayrollForms(context.operation, context.params.userId ?? '', context.input);
    // The timesheet half as it was sent, for a client that shows it at once.
    const period = submission.timesheetPeriodId === null ? null : await context.operation.repos.attendance.findPeriodById(submission.timesheetPeriodId);
    return { submission, period };
  },
});
