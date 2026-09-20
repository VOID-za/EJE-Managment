import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthenticatedActor, toSafeUser } from '@/server/api/actor';
import { errorResponse, logUnexpected, toApiError } from '@/server/api/errors';
import { getServerRuntime } from '@/server/runtime';

/**
 * Who the server says you are.
 *
 * THE ONLY SOURCE OF IDENTITY THE BROWSER HAS. It holds no user id, no role and
 * no session token; it asks, and what comes back is derived from the cookie the
 * server issued. A browser that decides it is a Master gets exactly as far as
 * drawing a menu it cannot use, because every route resolves the actor the same
 * way this does.
 *
 * `backend` is reported so the application can SAY when it is running the
 * demonstration store rather than the business's data. A demonstration that
 * looks identical to production is how somebody ends up capturing a real job
 * card into nothing.
 */
export const GET = async (request: NextRequest): Promise<NextResponse> => {
  try {
    const actor = await requireAuthenticatedActor(request);
    return NextResponse.json({
      data: { user: toSafeUser(actor.user), backend: getServerRuntime().backend },
    });
  } catch (cause) {
    logUnexpected('auth.me', cause);
    return errorResponse(toApiError(cause));
  }
};
