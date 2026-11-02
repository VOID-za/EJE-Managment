import { loadStandbySwapOptions } from '@/application/standby';
import { readRoute } from '@/server/api/handler';

/** `GET /api/standby/options` — the places the signed-in technician may offer, and ask for (STANDBY-5). */
export const GET = readRoute('standby.options', (context) =>
  loadStandbySwapOptions({ repos: context.repos, services: context.services, actor: context.actor.user }),
);
