import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthenticatedActor } from '@/server/api/actor';
import { errorResponse, logUnexpected, notFound, toApiError } from '@/server/api/errors';
import { customerView } from '@/server/api/views';
import { getServerRuntime } from '@/server/runtime';

export const GET = async (
  request: NextRequest,
  context: { params: Promise<{ customerId: string }> },
): Promise<NextResponse> => {
  try {
    const { customerId } = await context.params;
    const actor = await requireAuthenticatedActor(request);
    const data = await getServerRuntime().read(({ repos, services }) =>
      customerView({ repos, services, actor: actor.user }, customerId),
    );
    if (data === null) throw notFound('That customer does not exist.');
    return NextResponse.json({ data });
  } catch (cause) {
    logUnexpected('customers.view', cause);
    return errorResponse(toApiError(cause));
  }
};
