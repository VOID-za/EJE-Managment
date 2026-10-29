import { loadPayrollMonth } from '@/application/finance-packages';
import { readRoute } from '@/server/api/handler';

/** `GET /api/payroll/months/:month` — every technician's monthly status, the recipient and the packages (PAY-05). The office. */
export const GET = readRoute('payroll.office.month', (context) => loadPayrollMonth({ repos: context.repos, services: context.services, actor: context.actor.user }, context.params.month ?? ''));
