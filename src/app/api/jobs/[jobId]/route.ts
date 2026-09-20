import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthenticatedActor } from '@/server/api/actor';
import { errorResponse, logUnexpected, notFound, toApiError } from '@/server/api/errors';
import { jobView } from '@/server/api/views';
import { getServerRuntime } from '@/server/runtime';

/**
 * One job, with the users and the trail its screen needs.
 *
 * A job this actor may not read answers exactly as a job number nobody issued
 * does: 404. The two must be indistinguishable, or the response becomes a way
 * to ask which job numbers exist.
 */
export const GET = async (
  request: NextRequest,
  context: { params: Promise<{ jobId: string }> },
): Promise<NextResponse> => {
  try {
    const { jobId } = await context.params;
    const actor = await requireAuthenticatedActor(request);
    const data = await getServerRuntime().read(({ repos, services }) =>
      jobView({ repos, services, actor: actor.user }, jobId),
    );
    if (data === null) throw notFound('That job does not exist.');
    return NextResponse.json({ data });
  } catch (cause) {
    logUnexpected('jobs.view', cause);
    return errorResponse(toApiError(cause));
  }
};
