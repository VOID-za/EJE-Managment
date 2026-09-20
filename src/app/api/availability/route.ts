import { writeRoute } from '@/server/api/handler';
import {
  createAvailabilitySchema,
  runCreateAvailability,
} from '@/server/api/commands/office';

/**
 * Putting an absence on the calendar.
 *
 * Only the office creates one. A technician telling the office about an
 * appointment is a chat MESSAGE; `createAvailability` is what refuses anybody
 * else, and the two remain separate records.
 */
export const POST = writeRoute({
  operation: 'availability.create',
  schema: createAvailabilitySchema,
  handler: (context) =>
    runCreateAvailability(
      {
        repos: context.repos,
        services: context.services,
        actor: context.actor.user,
        operation: context.operation,
      },
      context.input,
    ),
});
