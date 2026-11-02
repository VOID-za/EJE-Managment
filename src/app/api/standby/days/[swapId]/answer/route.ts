import { z } from 'zod';
import { DAY_SWAP_NOTE_LIMIT, answerStandbyDaySwap } from '@/application/standby-days';
import { writeRoute } from '@/server/api/handler';

/** The person asked approves or denies a day swap (STANDBY-DAY-1, stage one). */
export const POST = writeRoute({
  operation: 'standby.days.answer',
  schema: z
    .object({
      decision: z.enum(['approve', 'deny']),
      note: z.string().max(DAY_SWAP_NOTE_LIMIT + 100).optional(),
    })
    .strict(),
  handler: async (context) => ({
    swap: await answerStandbyDaySwap(context.operation, context.params.swapId ?? '', {
      approve: context.input.decision === 'approve',
      note: context.input.note,
    }),
  }),
});
