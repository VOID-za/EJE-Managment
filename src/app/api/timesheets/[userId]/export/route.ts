import { z } from 'zod';
import { exportTimesheet } from '@/application/timesheets';
import { describeExport, recordExport } from '@/application/export-audit';
import { downloadRoute, parseWith } from '@/server/api/handler';

/**
 * `GET /api/timesheets/:userId/export?from=&to=` — the timesheet as a CSV, for
 * the office's records. TIMESHEET-1. Authorised exactly as the sheet itself is
 * read, and recorded on the audit trail like every other export (BD-18).
 */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Expected a date as YYYY-MM-DD');

export const GET = downloadRoute('timesheets.export', async (context) => {
  const { from, to } = parseWith(
    z.object({ from: day, to: day }).strict(),
    Object.fromEntries(context.request.nextUrl.searchParams),
  );
  const operation = { repos: context.repos, services: context.services, actor: context.actor.user };
  const file = await exportTimesheet(operation, context.params.userId ?? '', from, to);
  await recordExport(
    operation,
    describeExport({
      kind: 'timesheet',
      actor: context.actor.user,
      filters: { technician: context.params.userId ?? '', from, to },
      rowCount: file.rowCount,
      columns: file.columns,
      takenAt: context.services.clock.now(),
    }),
  );
  return { fileName: file.fileName, contentType: 'text/csv; charset=utf-8', body: file.csv };
});
