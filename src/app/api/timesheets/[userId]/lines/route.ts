import { z } from 'zod';
import { loadWorkingLines, saveTimesheetLine } from '@/application/timesheet-lines';
import { readRoute, writeRoute } from '@/server/api/handler';

const typed = z
  .object({
    pick: z.string().max(80),
    customerName: z.string().max(400),
    overtime: z.string().max(20),
    double: z.string().max(20),
    callout: z.string().max(20),
    internalKm: z.string().max(20),
    customerKm: z.string().max(20),
  })
  .strict();

/** `GET` — every line of the person's sheet, complete and draft (PAYROLL-ONE-1). */
export const GET = readRoute('timesheets.lines', (context) =>
  loadWorkingLines({ repos: context.repos, services: context.services, actor: context.actor.user }, context.params.userId ?? ''),
);

/**
 * `POST` — SAVE ONE LINE AS TYPED (PAYROLL-ONE-1). Complete: the stored line;
 * not complete yet: its draft, kept on the server. The owner only; a save from
 * an older revision of the line is refused (`timesheet_line_changed`).
 */
export const POST = writeRoute({
  operation: 'timesheets.line',
  schema: z
    .object({
      id: z.string().min(1).max(80).regex(/^[A-Za-z0-9-]+$/u, 'Expected a line id'),
      date: z.string().max(10).nullable(),
      typed,
      expectedRevision: z.string().max(64).nullable(),
    })
    .strict(),
  handler: async (context) => ({
    line: await saveTimesheetLine(context.operation, context.params.userId ?? '', context.input),
  }),
});
