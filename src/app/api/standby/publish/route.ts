import { z } from 'zod';
import { publishStandbyYear } from '@/application/standby';
import { writeRoute } from '@/server/api/handler';

/** Publishes the year's draft standby weeks (STANDBY-4). One-way. */
export const POST = writeRoute({
  operation: 'standby.publish',
  schema: z
    .object({
      year: z.number().int().min(2000).max(2200),
      acknowledgeIncomplete: z.boolean().default(false),
    })
    .strict(),
  handler: async (context) => ({ result: await publishStandbyYear(context.operation, context.input) }),
});
