import { z } from 'zod';
import { can } from '@/domain';
import { forbidden, notFound } from '@/server/api/errors';
import { writeRoute } from '@/server/api/handler';
import { getServerRuntime } from '@/server/runtime';

/**
 * Returning the demonstration to its seeded state.
 *
 * ONLY EXISTS WHEN THE DEMONSTRATION BACKEND IS RUNNING. Against PostgreSQL
 * `resetDemoData` is null and this answers 404 — not "refused", because there
 * is genuinely no such capability. A deployment holding a business's data has
 * no code path that can discard it, which is a stronger guarantee than a
 * permission check on one that does.
 *
 * Masters only, even in the demonstration: this throws away everything anybody
 * has captured during it.
 */
export const POST = writeRoute({
  operation: 'demo.reset',
  schema: z.object({}).strict(),
  handler: (context) => {
    const reset = getServerRuntime().resetDemoData;
    if (reset === null) throw notFound('There is nothing to reset.');

    if (!can(context.actor.user.role, 'settings.manage')) {
      throw forbidden('Only a Master can reset the demonstration data.', [
        { code: 'not_permitted', message: 'Your role does not administer the system.' },
      ]);
    }

    reset();
    return Promise.resolve({ reset: true });
  },
});
