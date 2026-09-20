import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthenticatedActor } from '@/server/api/actor';
import { errorResponse, logUnexpected, notFound, toApiError } from '@/server/api/errors';
import { technicianView } from '@/server/api/views';
import { getServerRuntime } from '@/server/runtime';

/** A technician's own page, or the office's view of somebody else's. */
export const GET = async (
  request: NextRequest,
  context: { params: Promise<{ userId: string }> },
): Promise<NextResponse> => {
  try {
    const { userId } = await context.params;
    const actor = await requireAuthenticatedActor(request);
    const data = await getServerRuntime().read(({ repos, services }) =>
      technicianView({ repos, services, actor: actor.user }, userId),
    );
    if (data === null) throw notFound('That person does not exist.');
    return NextResponse.json({ data });
  } catch (cause) {
    logUnexpected('users.view', cause);
    return errorResponse(toApiError(cause));
  }
};
