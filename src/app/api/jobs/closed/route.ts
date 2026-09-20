import { z } from 'zod';
import { emptyClosedJobFilters, type ClosedJobFilters } from '@/application/closed-jobs';
import { parseWith, readRoute } from '@/server/api/handler';
import { closedJobsView } from '@/server/api/views';

/**
 * The closed-job archive.
 *
 * `loadClosedJobs` refuses a role without the capability, so a technician
 * typing this URL is refused by the READ rather than by the screen. The filters
 * are validated against the same closed sets the screen offers — a job type
 * nobody has is a malformed request, not an empty result.
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

export const GET = readRoute('jobs.closed', (context) => {
  const query = parseWith(filters, Object.fromEntries(context.request.nextUrl.searchParams));
  const merged: ClosedJobFilters = { ...emptyClosedJobFilters, ...query };
  return closedJobsView(
    { repos: context.repos, services: context.services, actor: context.actor.user },
    merged,
  );
});
