import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthenticatedActor } from '@/server/api/actor';
import { errorResponse, logUnexpected, toApiError } from '@/server/api/errors';
import { staffAvailabilityView } from '@/server/api/views';
import { getServerRuntime } from '@/server/runtime';

/** `GET /api/staff` — every user's availability, for the Users screen. `availability.manage` only. */
export const GET = async (request: NextRequest): Promise<NextResponse> => {
  try {
    const actor = await requireAuthenticatedActor(request);
    const data = await getServerRuntime().read(({ repos, services }) =>
      staffAvailabilityView({ repos, services, actor: actor.user }),
    );
    return NextResponse.json({ data });
  } catch (cause) {
    logUnexpected('staff.view', cause);
    return errorResponse(toApiError(cause));
  }
};
