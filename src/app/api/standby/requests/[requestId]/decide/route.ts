import { z } from 'zod';
import { STANDBY_NOTE_LIMIT, decideStandbySwap } from '@/application/standby';
import { writeRoute } from '@/server/api/handler';

/**
 * THE OFFICE'S DECISION on a standby swap (STANDBY-6): approve — exchanging the
 * two places, all or nothing — or reject. Once, by a Master or Coordinator who
 * did not ask for it.
 */
export const POST = writeRoute({
  operation: 'standby.swap.decide',
  schema: z
    .object({
      decision: z.enum(['approve', 'reject']),
      note: z.string().max(STANDBY_NOTE_LIMIT + 100).optional(),
    })
    .strict(),
  handler: async (context) => ({
    request: await decideStandbySwap(context.operation, context.params.requestId ?? '', context.input),
  }),
});
