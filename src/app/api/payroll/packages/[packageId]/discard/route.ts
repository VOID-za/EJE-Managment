import { z } from 'zod';
import { discardFinancePackage } from '@/application/finance-packages';
import { writeRoute } from '@/server/api/handler';

/** DISCARD a package that has not been sent (PAY-06). Its record and files stay. */
export const POST = writeRoute({
  operation: 'payroll.package.discard',
  schema: z.object({}).strict(),
  handler: async (context) => ({ package: await discardFinancePackage(context.operation, context.params.packageId ?? '') }),
});
