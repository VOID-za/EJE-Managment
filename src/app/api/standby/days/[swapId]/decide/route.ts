import { z } from 'zod';
import { DAY_SWAP_NOTE_LIMIT, decideStandbyDaySwap } from '@/application/standby-days';
import { writeRoute } from '@/server/api/handler';

/**
 * THE OFFICE'S DECISION on a day swap the person asked has approved
 * (STANDBY-DAY-1, stage two): approve — exchanging every chosen day, all or
 * nothing — or reject.
 */
export const POST = writeRoute({
  operation: 'standby.days.decide',
  schema: z
    .object({
      decision: z.enum(['approve', 'reject']),
      note: z.string().max(DAY_SWAP_NOTE_LIMIT + 100).optional(),
    })
    .strict(),
  handler: async (context) => ({
    swap: await decideStandbyDaySwap(context.operation, context.params.swapId ?? '', {
      approve: context.input.decision === 'approve',
      note: context.input.note,
    }),
  }),
});
