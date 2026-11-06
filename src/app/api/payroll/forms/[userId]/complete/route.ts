import { z } from 'zod';
import { checkFormCompletion, completePayrollForm } from '@/application/payroll-completions';
import { parseWith, readRoute, writeRoute } from '@/server/api/handler';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Expected a date as YYYY-MM-DD');
const kind = z.enum(['timesheet', 'attendance']);

/**
 * `GET /api/payroll/forms/:userId/complete?kind=&from=&to=` — FORM-LIFECYCLE-1:
 * what the Completed dialog shows before OK — the name it proposes, what stops
 * it, what must be confirmed. Writes nothing.
 */
export const GET = readRoute('payroll.forms.complete.check', (context) => {
  const query = parseWith(z.object({ kind, from: day, to: day }).strict(), Object.fromEntries(context.request.nextUrl.searchParams));
  return checkFormCompletion({ repos: context.repos, services: context.services, actor: context.actor.user }, context.params.userId ?? '', query.kind, query.from, query.to);
});

/**
 * `POST /api/payroll/forms/:userId/complete` — OK in the Completed dialog: the
 * form is checked, frozen under its name and locked, in one transaction, once.
 * The person's own.
 */
export const POST = writeRoute({
  operation: 'payroll.forms.complete',
  schema: z
    .object({
      kind,
      from: day,
      to: day,
      fileName: z.string().max(200).default(''),
      confirmUnrecorded: z.boolean().optional(),
      confirmNoLines: z.boolean().optional(),
    })
    .strict(),
  handler: (context) => completePayrollForm(context.operation, context.params.userId ?? '', context.input),
});
