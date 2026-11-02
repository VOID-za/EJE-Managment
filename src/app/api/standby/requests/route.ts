import { z } from 'zod';
import { STANDBY_REASON_LIMIT, listStandbySwaps, requestStandbySwap } from '@/application/standby';
import { parseWith, readRoute, writeRoute } from '@/server/api/handler';

const filter = z.object({ status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional() }).strict();

/** `GET /api/standby/requests` — every swap request for the office; one's own for anybody else (STANDBY-7). */
export const GET = readRoute('standby.requests', (context) => {
  const { status } = parseWith(filter, Object.fromEntries(context.request.nextUrl.searchParams));
  return listStandbySwaps({ repos: context.repos, services: context.services, actor: context.actor.user }, status);
});

/**
 * A technician asks to swap one of their own standby places (STANDBY-5). The
 * requester is the session's user, never a value in the body.
 */
export const POST = writeRoute({
  operation: 'standby.swap.request',
  schema: z
    .object({
      kind: z.enum(['main', 'apprentice']),
      weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      counterpartId: z.string().min(1).max(100),
      counterpartWeekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      reason: z.string().max(STANDBY_REASON_LIMIT + 100).default(''),
    })
    .strict(),
  handler: async (context) => ({ request: await requestStandbySwap(context.operation, context.input) }),
});
