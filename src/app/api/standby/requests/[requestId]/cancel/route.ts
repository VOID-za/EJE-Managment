import { z } from 'zod';
import { cancelStandbySwap } from '@/application/standby';
import { writeRoute } from '@/server/api/handler';

/** The requester withdraws their own pending swap request (STANDBY-7). */
export const POST = writeRoute({
  operation: 'standby.swap.cancel',
  schema: z.object({}).strict(),
  handler: async (context) => ({
    request: await cancelStandbySwap(context.operation, context.params.requestId ?? ''),
  }),
});
