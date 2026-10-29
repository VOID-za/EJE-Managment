import { loadMonthlyForms } from '@/application/monthly-submissions';
import { readRoute } from '@/server/api/handler';

/** `GET /api/payroll/:userId/:month` — a technician's monthly forms and whether they can be submitted (PAY-02). Own, or the office. */
export const GET = readRoute('payroll.month.forms', (context) =>
  loadMonthlyForms({ repos: context.repos, services: context.services, actor: context.actor.user }, context.params.userId ?? '', context.params.month ?? ''),
);
