import { loadCurrentStandbyWeek } from '@/application/standby-days';
import { readRoute } from '@/server/api/handler';

/** `GET /api/standby/current-week` — this week's published standby, for the Overview (STANDBY-DASH-1). */
export const GET = readRoute('standby.current_week', (context) =>
  loadCurrentStandbyWeek({ repos: context.repos, services: context.services, actor: context.actor.user }),
);
