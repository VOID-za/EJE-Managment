import { z } from 'zod';
import { loadAttendancePeriodDocument } from '@/application/attendance-document';
import { onePageOrRefuse } from '@/application/payroll-pdf';
import { downloadRoute, parseWith } from '@/server/api/handler';
import { renderAttendancePdf } from '@/services/simulated/attendance-pdf';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Expected a date as YYYY-MM-DD');

/**
 * `GET /api/attendance/pdf?from=&to=` — one's own attendance for a chosen
 * period as a PDF (ATT-RANGE-1, PDF-NAME-1): across months, oldest day first,
 * named for every month it spans ("JC Atten Oct-Nov.pdf").
 */
export const GET = downloadRoute('attendance.period.pdf', async (context) => {
  const { from, to } = parseWith(z.object({ from: day, to: day }).strict(), Object.fromEntries(context.request.nextUrl.searchParams));
  const document = await loadAttendancePeriodDocument({ repos: context.repos, services: context.services, actor: context.actor.user }, from, to);
  const rendered = onePageOrRefuse(() => renderAttendancePdf(document, { generatedAt: context.services.clock.now() }));
  return { fileName: rendered.fileName, contentType: 'application/pdf', body: rendered.bytes, headers: { 'X-Page-Count': String(rendered.pageCount) } };
});
