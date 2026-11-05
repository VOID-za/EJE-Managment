import { z } from 'zod';
import { loadPayrollForms } from '@/application/payroll-forms';
import { parseWith, readRoute } from '@/server/api/handler';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Expected a date as YYYY-MM-DD');

/**
 * `GET /api/payroll/forms/:userId?from&to` — PAYROLL-ONE-1. The person's two
 * forms for exactly From–To, what stops their submission and the revision a
 * submission must name. Their own, or the office's view of anybody's. Writes nothing.
 */
export const GET = readRoute('payroll.forms', (context) => {
  const { from, to } = parseWith(z.object({ from: day, to: day }).strict(), Object.fromEntries(context.request.nextUrl.searchParams));
  return loadPayrollForms({ repos: context.repos, services: context.services, actor: context.actor.user }, context.params.userId ?? '', from, to);
});
