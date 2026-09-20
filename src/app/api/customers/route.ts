import { readRoute, writeRoute } from '@/server/api/handler';
import { createCustomerSchema, runCreateCustomer } from '@/server/api/commands/registers';
import { customersView } from '@/server/api/views';

export const GET = readRoute('customers.list', (context) =>
  customersView({ repos: context.repos, services: context.services, actor: context.actor.user }),
);

export const POST = writeRoute({
  operation: 'customers.create',
  schema: createCustomerSchema,
  handler: (context) =>
    runCreateCustomer(
      {
        repos: context.repos,
        services: context.services,
        actor: context.actor.user,
        operation: context.operation,
      },
      context.input,
    ),
});
