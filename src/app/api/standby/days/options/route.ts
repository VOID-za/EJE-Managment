import { loadStandbyDayOptions } from '@/application/standby-days';
import { readRoute } from '@/server/api/handler';

/** `GET /api/standby/days/options` — my future swappable days, and other eligible people's (STANDBY-DAY-1). */
export const GET = readRoute('standby.days.options', (context) =>
  loadStandbyDayOptions({ repos: context.repos, services: context.services, actor: context.actor.user }),
);
