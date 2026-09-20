import { can } from '@/domain';
import { readRoute } from '@/server/api/handler';
import { masterDashboardView, technicianDashboardView } from '@/server/api/views';

/**
 * The dashboard, which is a different screen for the office and for the field.
 *
 * WHICH ONE IS DECIDED HERE, from the role on the session. The browser asks for
 * "my dashboard" and is told what it is; it does not get to say.
 */
export const GET = readRoute('dashboard', async (context) => {
  const view = {
    repos: context.repos,
    services: context.services,
    actor: context.actor.user,
  };
  return can(context.actor.user.role, 'jobs.viewAll')
    ? { kind: 'office' as const, office: await masterDashboardView(view) }
    : { kind: 'field' as const, field: await technicianDashboardView(view) };
});
