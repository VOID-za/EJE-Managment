import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthenticatedActor } from '@/server/api/actor';
import { errorResponse, logUnexpected, notFound, toApiError } from '@/server/api/errors';
import { machineView } from '@/server/api/views';
import { getServerRuntime } from '@/server/runtime';

/**
 * One machine and its job history.
 *
 * Readable by a technician, because a machine's history is the most useful
 * thing to have before driving to it — the JOB ROWS are the actor's own view,
 * so DECISION 5 suppresses the prices on work that was not theirs.
 */
export const GET = async (
  request: NextRequest,
  context: { params: Promise<{ machineId: string }> },
): Promise<NextResponse> => {
  try {
    const { machineId } = await context.params;
    const actor = await requireAuthenticatedActor(request);
    const data = await getServerRuntime().read(({ repos, services }) =>
      machineView({ repos, services, actor: actor.user }, machineId),
    );
    if (data === null) throw notFound('That machine does not exist.');
    return NextResponse.json({ data });
  } catch (cause) {
    logUnexpected('machines.view', cause);
    return errorResponse(toApiError(cause));
  }
};
