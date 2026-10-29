import { z } from 'zod';
import { loadTimesheetDocument } from '@/application/timesheets';
import { downloadRoute, parseWith } from '@/server/api/handler';
import { parseTimesheetVersion, timesheetVersionParam } from '@/server/api/timesheet-line';
import { renderTimesheetPdf } from '@/services/simulated/timesheet-pdf';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Expected a date as YYYY-MM-DD');

/**
 * The timesheet PDF Layout's bytes for a chosen period (TS-11, TS-13,
 * PDF-01…04). A sent period is drawn from what was sent; a draft from its
 * lines as they stand. Same permission as reading the sheet; writes nothing.
 */
export const GET = downloadRoute('timesheets.pdf', async (context) => {
  const { from, to, version } = parseWith(
    z.object({ from: day, to: day, version: timesheetVersionParam }).strict(),
    Object.fromEntries(context.request.nextUrl.searchParams),
  );
  const operation = { repos: context.repos, services: context.services, actor: context.actor.user };
  const document = await loadTimesheetDocument(operation, context.params.userId ?? '', from, to, parseTimesheetVersion(version));
  const rendered = renderTimesheetPdf(document, { generatedAt: context.services.clock.now() });
  return { fileName: rendered.fileName, contentType: 'application/pdf', body: rendered.bytes };
});
