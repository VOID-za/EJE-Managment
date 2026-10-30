import { loadMonthlyHistory } from '@/application/monthly-submissions';
import { readRoute } from '@/server/api/handler';

/** `GET /api/payroll/:userId/history` — every month this person submitted, newest first. Own, or the office. */
export const GET = readRoute('payroll.history', (context) =>
  loadMonthlyHistory({ repos: context.repos, services: context.services, actor: context.actor.user }, context.params.userId ?? ''),
);
