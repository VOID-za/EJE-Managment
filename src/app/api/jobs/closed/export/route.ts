import { z } from 'zod';
import { emptyClosedJobFilters, type ClosedJobFilters } from '@/application/closed-jobs';
import { exportClosedJobs } from '@/application/exports';
import { describeExport, recordExport } from '@/application/export-audit';
import { downloadRoute, parseWith } from '@/server/api/handler';

/**
 * The closed-job archive as a CSV file. MASTER SCOPE SEARCH-4.
 *
 * `exportClosedJobs` goes through `loadClosedJobs`, which refuses a role
 * without `jobs.viewAll` before it reads a row — so a technician who types this
 * URL is refused by the READ, with the same wording the screen gives, and not
 * by a missing button. The filters are the archive screen's own, validated
 * exactly as its JSON route validates them.
 *
 * NO MONEY IN THE FILE. The archive's read model carries each job's issued
 * pricing snapshot so a historical document can be re-rendered at the rates it
 * was issued at; the export does not carry it, and `exports.ts` records why.
 */
const filters = z
  .object({
    term: z.string().max(200).optional(),
    customerId: z.string().max(100).optional(),
    siteId: z.string().max(100).optional(),
    jobType: z
      .enum(['all', 'breakdown', 'installation', 'service', 'parts', 'test_and_repair'])
      .optional(),
    technicianId: z.string().max(100).optional(),
    closedFrom: z.string().max(10).optional(),
    closedTo: z.string().max(10).optional(),
  })
  .strict();

export const GET = downloadRoute('jobs.closed.export', async (context) => {
  const query = parseWith(filters, Object.fromEntries(context.request.nextUrl.searchParams));
  const merged: ClosedJobFilters = { ...emptyClosedJobFilters, ...query };
  const file = await exportClosedJobs(context.repos, context.actor.user, merged);

  /*
   * The export-audit boundary. BD-18 — off unless the deployment sets
   * `EJE_EXPORT_AUDIT=on`. See `export-audit.ts`.
   */
  await recordExport(
    { repos: context.repos, services: context.services, actor: context.actor.user },
    describeExport({
      kind: 'closed-jobs',
      actor: context.actor.user,
      filters: Object.fromEntries(context.request.nextUrl.searchParams),
      rowCount: file.rowCount,
      /*
       * THE COLUMNS THAT ARE IN THE FILE, not a constant that could drift from
       * it. BD-17 made this actor-dependent: a Master holding
       * `jobs.exportPrices` — which nobody holds today — gets four more.
       */
      columns: file.columns,
      takenAt: context.services.clock.now(),
    }),
  );

  return { fileName: file.fileName, contentType: 'text/csv; charset=utf-8', body: file.csv };
});
