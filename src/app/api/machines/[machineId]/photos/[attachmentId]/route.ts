import { NextResponse, type NextRequest } from 'next/server';
import { asMachineId } from '@/domain';
import { requireAuthenticatedActor } from '@/server/api/actor';
import { errorResponse, logUnexpected, notFound, toApiError } from '@/server/api/errors';
import { PHOTO_CONTENT_TYPES, safeFileName } from '@/server/api/uploads';
import { getServerRuntime } from '@/server/runtime';

/**
 * `GET /api/machines/:machineId/photos/:attachmentId` — the photograph itself.
 * MACH-PHOTO-1.
 *
 * AUTHORIZATION BEFORE RETRIEVAL, against the MACHINE and never against the
 * file: any authenticated member of staff may read a machine and its history
 * (see the machine route — a machine's history is the most useful thing to have
 * before driving to it), and the photograph is part of that record. A storage
 * key is not a credential and there is no route that takes one.
 *
 * THE PHOTOGRAPH MUST BE ON THE MACHINE IN THE URL. An id belonging to another
 * machine, or to a job's media, answers the same 404 as a machine that does not
 * exist and a row whose bytes were never stored — which is what stops this
 * being used to ask which ids are real.
 *
 * Inline and sandboxed, like job media: a thumbnail has to render, and that is
 * safe only because the stored type was sniffed at upload and is checked again
 * here against the raster-image list.
 */
export const GET = async (
  request: NextRequest,
  context: { params: Promise<{ machineId: string; attachmentId: string }> },
): Promise<NextResponse> => {
  try {
    const { machineId, attachmentId } = await context.params;
    await requireAuthenticatedActor(request);

    const found = await getServerRuntime().read(async ({ repos, services }) => {
      const machine = await repos.machines.findById(asMachineId(machineId));
      if (machine === null) return null;
      const photo = machine.photos.find((candidate) => candidate.id === attachmentId);
      if (photo === undefined) return null;
      const document = await services.storage.getDocument(photo.storageKey);
      // A row from before MACH-PHOTO-1 has a key and no bytes. It must not
      // render as a broken image pretending to be a photograph.
      if (document === null) return null;
      return { photo, document };
    });

    if (found === null) throw notFound('That photograph does not exist.');
    if (!PHOTO_CONTENT_TYPES.includes(found.document.contentType)) {
      throw notFound('That photograph does not exist.');
    }

    const fileName = safeFileName(found.photo.fileName);
    return new NextResponse(found.document.bytes as unknown as BodyInit, {
      headers: {
        'content-type': found.document.contentType,
        'content-length': String(found.document.bytes.length),
        'content-disposition': `inline; filename="${fileName}"`,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        // A customer's machine. Not in a shared cache, and not left on a
        // tablet that has changed hands.
        'cache-control': 'private, no-store',
      },
    });
  } catch (cause) {
    logUnexpected('machines.photo', cause);
    return errorResponse(toApiError(cause));
  }
};
