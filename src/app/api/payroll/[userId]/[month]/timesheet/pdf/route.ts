import { z } from 'zod';
import { loadTimesheetDocument } from '@/application/timesheets';
import { onePageOrRefuse } from '@/application/payroll-pdf';
import { monthBounds } from '@/lib/payroll-files';
import { downloadRoute, parseWith } from '@/server/api/handler';
import { parseTimesheetVersion, timesheetVersionParam } from '@/server/api/timesheet-line';
import { renderTimesheetPdf } from '@/services/simulated/timesheet-pdf';

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u, 'Expected a month as YYYY-MM');

/** The month's timesheet PDF — ONE page, named "JC TIMESHEET OCT.pdf" (PAY-01, PAY-03, PAY-04). Writes nothing. */
export const GET = downloadRoute('payroll.month.timesheet.pdf', async (context) => {
  const { version } = parseWith(z.object({ version: timesheetVersionParam }).strict(), Object.fromEntries(context.request.nextUrl.searchParams));
  const { from, to } = monthBounds(parseWith(month, context.params.month ?? ''));
  const document = await loadTimesheetDocument({ repos: context.repos, services: context.services, actor: context.actor.user }, context.params.userId ?? '', from, to, parseTimesheetVersion(version));
  const rendered = onePageOrRefuse(() => renderTimesheetPdf(document, { generatedAt: context.services.clock.now() }));
  return { fileName: rendered.fileName, contentType: 'application/pdf', body: rendered.bytes, headers: { 'X-Page-Count': String(rendered.pageCount) } };
});
