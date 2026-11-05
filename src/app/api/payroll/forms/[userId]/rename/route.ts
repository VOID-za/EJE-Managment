import { z } from 'zod';
import { renamePayrollDocument } from '@/application/payroll-forms';
import { writeRoute } from '@/server/api/handler';

/** RENAME A WORKING PDF (PAYROLL-ONE-1). The person's own; an empty name goes back to the default. */
export const POST = writeRoute({
  operation: 'payroll.forms.rename',
  schema: z.object({ kind: z.enum(['timesheet', 'attendance']), name: z.string().max(400) }).strict(),
  handler: async (context) =>
    renamePayrollDocument(context.operation, context.params.userId ?? '', context.input.kind, context.input.name),
});
