import { z } from 'zod';
import { withdrawStandbyDaySwap } from '@/application/standby-days';
import { writeRoute } from '@/server/api/handler';

/** The requester withdraws a day swap the person asked has not answered yet (STANDBY-DAY-1). */
export const POST = writeRoute({
  operation: 'standby.days.withdraw',
  schema: z.object({}).strict(),
  handler: async (context) => ({ swap: await withdrawStandbyDaySwap(context.operation, context.params.swapId ?? '') }),
});
