import { writeRoute } from '@/server/api/handler';
import { createUserSchema, runCreateUser } from '@/server/api/commands/office';

/**
 * Adding a person.
 *
 * `createUser` decides who may: a Coordinator may add a Technician and nothing
 * else, and only a Master may add another Master. That rule is not repeated
 * here, because a rule stated twice is a rule that will disagree with itself.
 */
export const POST = writeRoute({
  operation: 'users.create',
  schema: createUserSchema,
  handler: (context) =>
    runCreateUser(
      {
        repos: context.repos,
        services: context.services,
        actor: context.actor.user,
        operation: context.operation,
      },
      context.input,
    ),
});
