import { z } from 'zod';
import { DAY_SWAP_MAX_PAIRS, DAY_SWAP_REASON_LIMIT, listStandbyDaySwaps, requestStandbyDaySwap } from '@/application/standby-days';
import { readRoute, writeRoute } from '@/server/api/handler';

const position = z.enum(['main', 'helper', 'apprentice_1', 'apprentice_2']);

/** `GET /api/standby/days` — day swaps: every one for the Office, one's own for anybody else (STANDBY-DAY-1). */
export const GET = readRoute('standby.days', (context) =>
  listStandbyDaySwaps({ repos: context.repos, services: context.services, actor: context.actor.user }),
);

/**
 * A technician or apprentice asks another to swap chosen DAYS (STANDBY-DAY-1).
 * The requester is the session's user, never a value in the body.
 */
export const POST = writeRoute({
  operation: 'standby.days.request',
  schema: z
    .object({
      recipientId: z.string().min(1).max(100),
      kind: z.enum(['main', 'apprentice']),
      pairs: z
        .array(
          z
            .object({
              requesterDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
              requesterPosition: position,
              recipientDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
              recipientPosition: position,
            })
            .strict(),
        )
        .min(1)
        .max(DAY_SWAP_MAX_PAIRS),
      reason: z.string().max(DAY_SWAP_REASON_LIMIT + 100).default(''),
    })
    .strict(),
  handler: async (context) => ({ swap: await requestStandbyDaySwap(context.operation, context.input) }),
});
