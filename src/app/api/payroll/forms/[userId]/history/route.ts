import { listPayrollHistory } from '@/application/payroll-forms';
import { readRoute } from '@/server/api/handler';

/** `GET /api/payroll/forms/:userId/history` — every submission, current and replaced, newest first. */
export const GET = readRoute('payroll.forms.history', (context) =>
  listPayrollHistory({ repos: context.repos, services: context.services, actor: context.actor.user }, context.params.userId ?? ''),
);
