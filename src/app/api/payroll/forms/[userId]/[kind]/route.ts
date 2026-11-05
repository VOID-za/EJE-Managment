import { z } from 'zod';
import { loadPayrollFormDocument } from '@/application/payroll-forms';
import { parseWith, readRoute } from '@/server/api/handler';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Expected a date as YYYY-MM-DD');
const kind = z.enum(['timesheet', 'attendance']);

/** One working form for From–To, as its PDF prints it, under its stored name. Writes nothing. */
export const GET = readRoute('payroll.forms.document', (context) => {
  const { from, to } = parseWith(z.object({ from: day, to: day }).strict(), Object.fromEntries(context.request.nextUrl.searchParams));
  return loadPayrollFormDocument(
    { repos: context.repos, services: context.services, actor: context.actor.user },
    context.params.userId ?? '',
    parseWith(kind, context.params.kind ?? ''),
    from,
    to,
  );
});
