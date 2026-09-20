import { readRoute, writeRoute } from '@/server/api/handler';
import { createMachineSchema, runCreateMachine } from '@/server/api/commands/registers';
import { machinesView } from '@/server/api/views';

export const GET = readRoute('machines.list', (context) =>
  machinesView({ repos: context.repos, services: context.services, actor: context.actor.user }),
);

export const POST = writeRoute({
  operation: 'machines.create',
  schema: createMachineSchema,
  handler: (context) =>
    runCreateMachine(
      {
        repos: context.repos,
        services: context.services,
        actor: context.actor.user,
        operation: context.operation,
      },
      context.input,
    ),
});
