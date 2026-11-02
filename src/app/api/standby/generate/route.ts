import { z } from 'zod';
import { generateStandbyYear } from '@/application/standby';
import { writeRoute } from '@/server/api/handler';

const order = z.array(z.string().min(1).max(100)).max(60).optional();

/**
 * Generates a year's standby weeks as DRAFTS (STANDBY-4). Fills only empty
 * places of draft weeks, from the order the office gives; never touches a
 * published week, a filled place or a past week.
 */
export const POST = writeRoute({
  operation: 'standby.generate',
  schema: z
    .object({
      year: z.number().int().min(2000).max(2200),
      rotation: z
        .object({ main: order, helper: order, apprentice_1: order, apprentice_2: order })
        .strict()
        .optional(),
    })
    .strict(),
  handler: async (context) => ({ result: await generateStandbyYear(context.operation, context.input) }),
});
