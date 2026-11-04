import { exportTimesheetSubmission } from '@/application/timesheets';
import { describeExport, recordExport } from '@/application/export-audit';
import { downloadRoute } from '@/server/api/handler';

/** TS-PAPER. One submission's lines as a spreadsheet, for the office; the export is audited. */
export const GET = downloadRoute('timesheets.submissionExport', async (context) => {
  const operation = { repos: context.repos, services: context.services, actor: context.actor.user };
  const file = await exportTimesheetSubmission(operation, context.params.periodId ?? '');
  await recordExport(
    operation,
    describeExport({
      kind: 'timesheet',
      actor: context.actor.user,
      filters: { submission: context.params.periodId ?? '' },
      rowCount: file.rowCount,
      columns: file.columns,
      takenAt: context.services.clock.now(),
    }),
  );
  return { fileName: file.fileName, contentType: 'text/csv; charset=utf-8', body: file.csv };
});
