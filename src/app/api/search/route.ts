import { z } from 'zod';
import { parseWith, readRoute } from '@/server/api/handler';
import { searchView } from '@/server/api/views';

/**
 * Global search.
 *
 * Scoped by the SAME rules as a job read — `runSearch` applies DECISION 5 to
 * its results before matching — so a technician cannot find another
 * technician's live job by typing its number.
 */
const query = z.object({ q: z.string().max(200).optional() }).strict();

export const GET = readRoute('search', (context) => {
  const { q } = parseWith(query, Object.fromEntries(context.request.nextUrl.searchParams));
  return searchView(
    { repos: context.repos, services: context.services, actor: context.actor.user },
    q ?? '',
  );
});
