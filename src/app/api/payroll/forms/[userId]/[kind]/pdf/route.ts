import { z } from 'zod';
import { loadPayrollFormDocument } from '@/application/payroll-forms';
import type { AttendanceDocument } from '@/application/attendance-document';
import type { TimesheetDocument } from '@/application/timesheets';
import { onePageOrRefuse } from '@/application/payroll-pdf';
import { downloadRoute, parseWith } from '@/server/api/handler';
import { renderAttendancePdf } from '@/services/simulated/attendance-pdf';
import { renderTimesheetPdf } from '@/services/simulated/timesheet-pdf';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Expected a date as YYYY-MM-DD');
const kind = z.enum(['timesheet', 'attendance']);

/**
 * The working form's PDF for From–To, under the name the person gave it —
 * Preview, Print, Download and Save PDF all use this. Writes nothing.
 */
export const GET = downloadRoute('payroll.forms.pdf', async (context) => {
  const { from, to } = parseWith(z.object({ from: day, to: day }).strict(), Object.fromEntries(context.request.nextUrl.searchParams));
  const which = parseWith(kind, context.params.kind ?? '');
  const operation = { repos: context.repos, services: context.services, actor: context.actor.user };
  const document = await loadPayrollFormDocument(operation, context.params.userId ?? '', which, from, to);
  const generatedAt = context.services.clock.now();
  const rendered =
    which === 'attendance'
      ? onePageOrRefuse(() => renderAttendancePdf(document as AttendanceDocument, { generatedAt }))
      : renderTimesheetPdf(document as TimesheetDocument, { generatedAt });
  return { fileName: rendered.fileName, contentType: 'application/pdf', body: rendered.bytes, headers: { 'X-Page-Count': String(rendered.pageCount) } };
});
