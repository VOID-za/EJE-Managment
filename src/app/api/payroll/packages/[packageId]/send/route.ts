import { z } from 'zod';
import { sendFinancePackage } from '@/application/finance-packages';
import { writeRoute } from '@/server/api/handler';

/** SEND the package as ONE email (PAY-07). Once: a retry or a second click is refused or replayed. */
export const POST = writeRoute({
  operation: 'payroll.package.send',
  schema: z.object({}).strict(),
  handler: async (context) => ({ package: await sendFinancePackage(context.operation, context.params.packageId ?? '') }),
});
