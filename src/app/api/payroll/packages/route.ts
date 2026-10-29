import { z } from 'zod';
import { prepareFinancePackage } from '@/application/finance-packages';
import { writeRoute } from '@/server/api/handler';

/** PREPARE the month's Finance package (PAY-06): render, check, store, record. Nothing is sent. */
export const POST = writeRoute({
  operation: 'payroll.package.prepare',
  schema: z
    .object({
      month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u, 'Expected a month as YYYY-MM'),
      technicianIds: z.array(z.string().min(1).max(100)).min(1).max(200),
    })
    .strict(),
  handler: async (context) => ({
    package: await prepareFinancePackage(context.operation, context.input.month, context.input.technicianIds),
  }),
});
