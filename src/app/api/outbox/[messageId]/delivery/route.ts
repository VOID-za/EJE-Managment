import { z } from 'zod';
import { can } from '@/domain';
import { confirmJobCardDelivery } from '@/application/job-operations';
import { forbidden } from '@/server/api/errors';
import { writeRoute } from '@/server/api/handler';
import { getServerRuntime } from '@/server/runtime';

/**
 * What the provider would have reported about a message it accepted.
 *
 * DEMONSTRATION ONLY, and deliberately narrow: production learns this from the
 * provider's delivery report, not from anybody pressing a button. It exists so
 * the Simulated Outbox screen can stand in for that report while the
 * integrations are still ahead of us.
 *
 * Restricted to the office. A technician being able to declare a customer's
 * copy delivered would close a job on a send nothing confirmed, which is the
 * exact failure the delivery handshake exists to prevent.
 */
export const POST = writeRoute({
  operation: 'outbox.report_delivery',
  schema: z
    .object({
      state: z.enum(['not_started', 'sending', 'pending_delivery', 'delivered', 'failed']),
      failureReason: z.string().max(500).optional(),
    })
    .strict(),
  handler: async (context) => {
    if (!can(context.actor.user.role, 'jobs.submit')) {
      throw forbidden('Only the office reports on a customer’s copy.', [
        { code: 'not_permitted', message: 'Your role does not issue job cards.' },
      ]);
    }
    const messageId = context.params.messageId ?? '';
    await getServerRuntime().outbox.setDelivery(
      messageId,
      context.input.state,
      context.input.failureReason ?? '',
    );

    /*
     * Any job waiting on this message now hears about it.
     *
     * Done HERE rather than by the browser looping over jobs: learning what
     * became of a customer's copy is a business consequence of the report, and
     * `confirmJobCardDelivery` is what decides whether that closes the job.
     */
    const waiting = await context.repos.jobs.list({ statuses: ['awaiting_delivery'] });
    let closed = 0;
    for (const job of waiting) {
      if (job.delivery?.messageId !== messageId) continue;
      const settled = await confirmJobCardDelivery(context.operation, job);
      if (settled.status === 'closed') closed += 1;
    }
    return { reported: true, closed };
  },
});
