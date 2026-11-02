import { z } from 'zod';
import { setStandbyEligibility } from '@/application/standby';
import { writeRoute } from '@/server/api/handler';

/** Who may stand in which standby place (STANDBY-1). The office. */
export const POST = writeRoute({
  operation: 'standby.eligibility',
  schema: z
    .object({
      userId: z.string().min(1).max(100),
      main: z.boolean(),
      helper: z.boolean(),
      apprentice: z.boolean(),
    })
    .strict(),
  handler: async (context) => ({ eligibility: await setStandbyEligibility(context.operation, context.input) }),
});
