import { z } from 'zod';
import { searchLibraryText } from '@/application/library-search';
import { parseWith, readRoute } from '@/server/api/handler';
import { MAX_QUERY_LENGTH } from '@/lib/text-search';

/**
 * `GET /api/library/search` — the words INSIDE the documents. MASTER SCOPE LIB-5.
 *
 * `searchLibraryText` refuses an actor without `library.view` and searches only
 * CURRENT revisions, so a technician typing this URL gets exactly what the
 * library screen would give them: nothing pending, nothing archived, and no
 * document they may not read. The authorisation is in the read, not here.
 *
 * The query is validated by the application — its length, the page range, and
 * whether there is a searchable term in it at all — because those refusals
 * carry the wording the screen renders. What this schema stops is a malformed
 * REQUEST: a page that is not a number, or a parameter nobody offers.
 */
const query = z
  .object({
    q: z.string().max(MAX_QUERY_LENGTH + 20),
    page: z.string().max(4).regex(/^\d+$/, 'The page must be a number.').optional(),
  })
  .strict();

export const GET = readRoute('library.search', (context) => {
  const input = parseWith(query, Object.fromEntries(context.request.nextUrl.searchParams));
  return searchLibraryText(context.repos, context.actor.user, {
    term: input.q,
    page: input.page === undefined ? 1 : Number(input.page),
  });
});
