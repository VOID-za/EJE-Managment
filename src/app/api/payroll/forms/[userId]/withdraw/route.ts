import { z } from 'zod';
import { withdrawCompletedForm } from '@/application/payroll-completions';
import { writeRoute } from '@/server/api/handler';

/**
 * `POST /api/payroll/forms/:userId/withdraw` — FORM-WITHDRAW-1: Withdraw and
 * Correct on My Monthly Forms. The owner's completed form, still awaiting
 * Submit to Office, is withdrawn — kept exactly as completed — and a correction
 * draft opens on its dates, in one transaction, once. Never a submitted form.
 */
export const POST = writeRoute({
  operation: 'payroll.forms.withdraw',
  schema: z.object({ completionId: z.string().min(1).max(100) }).strict(),
  handler: (context) => withdrawCompletedForm(context.operation, context.params.userId ?? '', context.input.completionId),
});
