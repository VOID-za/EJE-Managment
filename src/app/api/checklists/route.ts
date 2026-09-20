import { writeRoute } from '@/server/api/handler';
import { createTemplateSchema, runCreateTemplate } from '@/server/api/commands/office';

export const POST = writeRoute({
  operation: 'checklists.create',
  schema: createTemplateSchema,
  handler: (context) =>
    runCreateTemplate(
      {
        repos: context.repos,
        services: context.services,
        actor: context.actor.user,
        operation: context.operation,
      },
      context.input,
    ),
});
