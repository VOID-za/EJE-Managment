import { z } from 'zod';
import { submitCompletedForms } from '@/application/payroll-completions';
import { writeRoute } from '@/server/api/handler';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Expected a date as YYYY-MM-DD');

/**
 * SUBMIT TO OFFICE (FORM-LIFECYCLE-1, the owner, 6 November 2026): the
 * person's two COMPLETED forms — timesheet and attendance, for the same dates
 * — go to the office together as one submission, in one transaction, once.
 * Never one form on its own, and never anything not completed first: what is
 * submitted is decided by the completed forms on the server, not by the
 * request. The older request body (From, To, revision, confirmations) is still
 * accepted and ignored, so a page from before this release is answered
 * plainly instead of failing on its shape.
 */
export const POST = writeRoute({
  operation: 'payroll.forms.submit',
  schema: z
    .object({
      from: day.optional(),
      to: day.optional(),
      revision: z.string().min(1).max(200).optional(),
      confirmUnrecorded: z.boolean().optional(),
      confirmNoLines: z.boolean().optional(),
      confirmReplace: z.boolean().optional(),
    })
    .strict(),
  handler: async (context) => {
    const submission = await submitCompletedForms(context.operation, context.params.userId ?? '');
    // The timesheet half as it was sent, for a client that shows it at once.
    const period = submission.timesheetPeriodId === null ? null : await context.operation.repos.attendance.findPeriodById(submission.timesheetPeriodId);
    return { submission, period };
  },
});
