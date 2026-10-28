import { loadTimesheetDocument } from '@/application/timesheets';
import { downloadRoute } from '@/server/api/handler';
import { renderTimesheetPdf } from '@/services/simulated/timesheet-pdf';

/**
 * The timesheet PDF Layout's bytes (TS-11, TS-13, PDF-01…04). A submitted
 * month is drawn from what was sent; a draft from its lines as they stand.
 * Same permission as reading the sheet. A read: nothing is written.
 */
export const GET = downloadRoute('timesheets.pdf', async (context) => {
  const operation = { repos: context.repos, services: context.services, actor: context.actor.user };
  const document = await loadTimesheetDocument(operation, context.params.userId ?? '', context.params.month ?? '');
  const rendered = renderTimesheetPdf(document, {
    companyName: document.companyName,
    generatedAt: context.services.clock.now(),
  });
  return { fileName: rendered.fileName, contentType: 'application/pdf', body: rendered.bytes };
});
