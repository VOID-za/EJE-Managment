import { z } from 'zod';
import { resolveChangeRequest } from '@/application/change-request-operations';
import { writeRoute } from '@/server/api/handler';

/**
 * `POST /api/change-requests/:requestId/resolve` — the office says what they
 * did about a report. CUST-CR.
 *
 * `applied` means they made the change, by hand, through the register screens;
 * `declined` means they decided not to. **Neither writes to the register from
 * here**, and that is the boundary rather than an omission — see
 * `src/application/change-request-operations.ts`, which explains which
 * questions an automatic apply would require EJE to answer first.
 *
 * The note is required on both outcomes: "declined" with no reason is how
 * people stop reporting things, and "applied" with no note leaves nobody able
 * to tell what was actually changed.
 */
export const POST = writeRoute({
  operation: 'customers.resolveChangeRequest',
  schema: z
    .object({
      outcome: z.enum(['applied', 'declined']),
      note: z.string().min(1).max(2000),
    })
    .strict(),
  handler: async (context) =>
    resolveChangeRequest(context.operation, context.params.requestId ?? '', {
      outcome: context.input.outcome,
      note: context.input.note,
    }),
});
