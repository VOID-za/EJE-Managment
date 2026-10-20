import { NextResponse, type NextRequest } from 'next/server';
import { asMachineId } from '@/domain';
import { readMachineDocument } from '@/application/machine-documents';
import { requireAuthenticatedActor } from '@/server/api/actor';
import { errorResponse, logUnexpected, notFound, toApiError } from '@/server/api/errors';
import { safeFileName } from '@/server/api/uploads';
import { getServerRuntime } from '@/server/runtime';

/**
 * `GET /api/machines/:machineId/documents/:documentId` — the file itself.
 * October mandate §4.
 *
 * AUTHORISATION BEFORE RETRIEVAL, and the storage key is never part of the
 * request: who is asking (session), is this document THIS machine's, and may
 * this role read THIS document — the office all of them, a technician the ones
 * the office marked for the field. Only then is anything read out of storage.
 *
 * EVERY REFUSAL IS THE SAME 404 — a document that does not exist, one
 * belonging to another machine, one a technician may not read, and one whose
 * bytes are gone. A 403 on the audience would tell a technician which machines
 * carry paperwork the office is keeping from them, which is information and not
 * an answer. A damaged file is the one exception and answers 422, because
 * "this exists and is corrupt" is what the office needs to hear and an
 * attacker cannot provoke it without already being authorised.
 *
 * ALWAYS AN ATTACHMENT, never inline, unlike a machine PHOTOGRAPH: a
 * photograph has to render as a thumbnail and is checked against the raster
 * list before it does, while this may be any document type and must not be
 * treated by the browser as part of this application.
 */
export const GET = async (
  request: NextRequest,
  context: { params: Promise<{ machineId: string; documentId: string }> },
): Promise<NextResponse> => {
  try {
    const { machineId, documentId } = await context.params;
    const actor = await requireAuthenticatedActor(request);

    const found = await getServerRuntime().read(async ({ repos, services }) => {
      const operation = { repos, services, actor: actor.user };
      return readMachineDocument(operation, asMachineId(machineId), documentId);
    });

    if (found === null) throw notFound('That document does not exist.');

    const fileName = safeFileName(found.document.fileName);
    return new NextResponse(found.file.bytes as unknown as BodyInit, {
      headers: {
        'content-type': found.file.contentType,
        'content-length': String(found.file.bytes.length),
        'content-disposition': `attachment; filename="${fileName}"`,
        // The sniffed type is the truth; the browser must not go looking for a
        // more interesting one.
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        // A customer's machine. Not in a shared cache, and not left on a
        // tablet that has changed hands.
        'cache-control': 'private, no-store',
      },
    });
  } catch (cause) {
    logUnexpected('machines.document', cause);
    return errorResponse(toApiError(cause));
  }
};
