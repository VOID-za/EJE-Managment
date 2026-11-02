import { z } from 'zod';
import { STANDBY_REASON_LIMIT, assignStandby } from '@/application/standby';
import { writeRoute } from '@/server/api/handler';

/**
 * The office fills, changes or empties one standby place (STANDBY-4). Refused
 * if the place no longer holds who the screen showed (`expectedUserId`).
 */
export const POST = writeRoute({
  operation: 'standby.assign',
  schema: z
    .object({
      weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      position: z.enum(['main', 'helper', 'apprentice_1', 'apprentice_2']),
      userId: z.string().min(1).max(100).nullable(),
      expectedUserId: z.string().min(1).max(100).nullable(),
      reason: z.string().max(STANDBY_REASON_LIMIT + 100).default(''),
    })
    .strict(),
  handler: async (context) => assignStandby(context.operation, context.input),
});
