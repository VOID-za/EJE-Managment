import { z } from 'zod';
import { loadTimesheetDocument } from '@/application/timesheets';
import { monthBounds } from '@/lib/payroll-files';
import { parseWith, readRoute } from '@/server/api/handler';
import { parseTimesheetVersion, timesheetVersionParam } from '@/server/api/timesheet-line';

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u, 'Expected a month as YYYY-MM');

/** The month's timesheet as its PDF Layout prints it (PAY-01): the screen draws the preview from this. */
export const GET = readRoute('payroll.month.timesheet', (context) => {
  const { version } = parseWith(z.object({ version: timesheetVersionParam }).strict(), Object.fromEntries(context.request.nextUrl.searchParams));
  const value = parseWith(month, context.params.month ?? '');
  const { from, to } = monthBounds(value);
  return loadTimesheetDocument({ repos: context.repos, services: context.services, actor: context.actor.user }, context.params.userId ?? '', from, to, parseTimesheetVersion(version));
});
