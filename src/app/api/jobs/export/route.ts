import { z } from 'zod';
import { JOB_STATUS_ORDER, JOB_TYPE_CODES, PRIORITY_ORDER } from '@/domain';
import { exportJobList } from '@/application/exports';
import { describeExport, recordExport } from '@/application/export-audit';
import { emptyJobListFilters, type JobListFilters } from '@/application/job-list-filters';
import { downloadRoute, parseWith } from '@/server/api/handler';

/**
 * The Jobs list as a CSV file. MASTER SCOPE SEARCH-4.
 *
 * THE SAME READ AND THE SAME FILTERS AS THE SCREEN. `exportJobList` calls
 * `loadActiveJobList`, which applies DECISION 5 — so a technician's file holds
 * the work a technician may see, and no amount of query string gets them
 * another job. The filter names below are the ones the Jobs screen already
 * puts in its own URL, so the export link is the screen's state written out.
 *
 * VALIDATED, NOT COERCED. A status or a job type that does not exist is a
 * malformed request and is refused with 400, rather than silently filtering
 * everything away and handing back an empty file that looks like an answer.
 */
/*
 * DERIVED FROM THE DOMAIN, so a new status cannot be exportable on the screen
 * and a 400 here. The membership test is a `Set` rather than a spelled-out
 * `z.enum` for exactly that reason.
 */
const STATUS_FILTERS = new Set<string>([
  ...JOB_STATUS_ORDER,
  'all',
  'open-work',
  'awaiting_completion',
  'overdue',
]);
const JOB_TYPE_FILTERS = new Set<string>([...JOB_TYPE_CODES, 'all']);
const PRIORITY_FILTERS = new Set<string>([...PRIORITY_ORDER, 'all']);

const filters = z
  .object({
    status: z
      .string()
      .max(40)
      .refine((value) => STATUS_FILTERS.has(value), 'That is not one of the status filters.')
      .optional(),
    jobType: z
      .string()
      .max(40)
      .refine((value) => JOB_TYPE_FILTERS.has(value), 'That is not a job type.')
      .optional(),
    priority: z
      .string()
      .max(40)
      .refine((value) => PRIORITY_FILTERS.has(value), 'That is not a priority.')
      .optional(),
    mine: z.enum(['0', '1']).optional(),
    signatureRefusal: z.enum(['unresolved']).optional(),
    term: z.string().max(200).optional(),
  })
  .strict();

export const GET = downloadRoute('jobs.export', async (context) => {
  const query = parseWith(filters, Object.fromEntries(context.request.nextUrl.searchParams));
  const merged: JobListFilters = {
    ...emptyJobListFilters,
    ...(query.status === undefined ? {} : { status: query.status as JobListFilters['status'] }),
    ...(query.jobType === undefined ? {} : { jobType: query.jobType as JobListFilters['jobType'] }),
    ...(query.priority === undefined
      ? {}
      : { priority: query.priority as JobListFilters['priority'] }),
    mineOnly: query.mine === '1',
    refusalsOnly: query.signatureRefusal === 'unresolved',
    term: query.term ?? '',
  };

  const file = await exportJobList(context.repos, context.actor.user, merged);

  /*
   * THE EXPORT-AUDIT BOUNDARY. BD-18, and it writes NOTHING today.
   *
   * Issue #25 asked whether an export belongs on the audit trail and nobody
   * has answered. The call is here so the mechanism is real and tested rather
   * than imagined; `recordExport` returns the record it WOULD write and
   * touches no repository while `EXPORT_AUDIT.recording` is false. The file is
   * produced either way — an audit decision cannot be allowed to fail an
   * authorised read.
   */
  await recordExport(
    { repos: context.repos, services: context.services, actor: context.actor.user },
    describeExport({
      kind: 'jobs',
      actor: context.actor.user,
      filters: Object.fromEntries(context.request.nextUrl.searchParams),
      rowCount: file.rowCount,
      // The columns in the file; see the closed-job route. BD-17.
      columns: file.columns,
      takenAt: context.services.clock.now(),
    }),
  );

  return { fileName: file.fileName, contentType: 'text/csv; charset=utf-8', body: file.csv };
});
