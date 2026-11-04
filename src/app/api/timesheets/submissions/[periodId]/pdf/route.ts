import { z } from 'zod';
import { loadSubmissionDocument } from '@/application/timesheets';
import { downloadRoute, parseWith } from '@/server/api/handler';
import { parseTimesheetVersion, timesheetVersionParam } from '@/server/api/timesheet-line';
import { renderTimesheetPdf } from '@/services/simulated/timesheet-pdf';

/** TS-PAPER. One submission's PDF. */
export const GET = downloadRoute('timesheets.submissionPdf', async (context) => {
  const { version } = parseWith(
    z.object({ version: timesheetVersionParam }).strict(),
    Object.fromEntries(context.request.nextUrl.searchParams),
  );
  const operation = { repos: context.repos, services: context.services, actor: context.actor.user };
  const document = await loadSubmissionDocument(operation, context.params.periodId ?? '', parseTimesheetVersion(version));
  const rendered = renderTimesheetPdf(document, { generatedAt: context.services.clock.now() });
  return { fileName: rendered.fileName, contentType: 'application/pdf', body: rendered.bytes };
});
