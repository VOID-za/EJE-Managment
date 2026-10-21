import { NextResponse, type NextRequest } from 'next/server';
import { readJobMedia } from '@/application/job-operations';
import { requireAuthenticatedActor } from '@/server/api/actor';
import { loadVisibleJob } from '@/server/api/commands/jobs';
import { errorResponse, logUnexpected, notFound, toApiError } from '@/server/api/errors';
import { PHOTO_CONTENT_TYPES, safeFileName, VIDEO_CONTENT_TYPES } from '@/server/api/uploads';
import { getServerRuntime } from '@/server/runtime';

/**
 * `GET /api/jobs/:jobId/media/:attachmentId` — the photograph or the video
 * itself. PWA-3, MEDIA-5.
 *
 * WHY IT HAD TO EXIST. A capture nobody can look at is not a capture: the
 * technician has to see that the frame is the machine and not their thumb
 * before the customer signs for the work it evidences. The bytes were being
 * stored and there was no authenticated way to read one back.
 *
 * AUTHORIZATION BEFORE RETRIEVAL, as with every file on a job: who is asking
 * (session), may they see this job at all (`loadVisibleJob`, the same rule
 * every job read goes through), is this media on THAT job (`readJobMedia`,
 * which looks only in that job's own lists). Only then is storage touched, and
 * every refusal is the same 404 — a job that is not theirs, an id from another
 * job and a row whose bytes were never stored are indistinguishable from
 * outside.
 *
 * SERVED INLINE, WHICH THE DOCUMENT ROUTE REFUSES TO DO, so the difference is
 * worth stating. That route forces `attachment` because a PDF rendered in this
 * origin runs in this application's context. Here:
 *
 *   - the type is the SNIFFED type from capture, and the list is raster images
 *     and the four video containers — no SVG, no HTML, nothing with a script
 *     in it, so there is no document to execute. A row that somehow holds
 *     anything else is refused below rather than served;
 *   - `nosniff` stops the browser looking for a more interesting type;
 *   - the sandbox CSP means that even if a byte sequence were somehow treated
 *     as a document, it would have no script, no origin and no plugins.
 *
 * `private, no-store` because this is a customer's site, their machine and
 * sometimes their fault — it does not belong in a shared cache, and a tablet
 * handed to the next technician must not still hold it. The service worker
 * refuses to cache anything under `/api/` for the same reason.
 */
export const GET = async (
  request: NextRequest,
  context: { params: Promise<{ jobId: string; attachmentId: string }> },
): Promise<NextResponse> => {
  try {
    const { jobId, attachmentId } = await context.params;
    const actor = await requireAuthenticatedActor(request);

    const found = await getServerRuntime().read(async ({ repos, services }) => {
      const operation = { repos, services, actor: actor.user };
      const job = await loadVisibleJob({ ...operation, operation }, jobId);
      return readJobMedia(operation, job, attachmentId);
    });

    if (found === null) throw notFound('That photograph does not exist.');
    /*
     * Belt and braces: capture sniffs the bytes, and this refuses to serve a
     * row that is not an image or a video even so. One of the two has to be
     * the last word, and it should be the one at the moment of serving.
     *
     * THE LIST GREW WITH MEDIA-5 AND THE REFUSAL DID NOT WEAKEN. A video
     * container is as inert as a JPEG in a browser: no script, no origin, and
     * the sandbox CSP below holds for both. What is NOT on either list is
     * anything a browser would treat as a document, which is the property this
     * check exists to keep.
     */
    const servable = [...PHOTO_CONTENT_TYPES, ...VIDEO_CONTENT_TYPES];
    if (!servable.includes(found.document.contentType)) {
      throw notFound('That photograph does not exist.');
    }

    const fileName = safeFileName(found.attachment.fileName);
    return new NextResponse(found.document.bytes as unknown as BodyInit, {
      headers: {
        'content-type': found.document.contentType,
        'content-length': String(found.document.bytes.length),
        'content-disposition': `inline; filename="${fileName}"`,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        /*
         * NO RANGE SUPPORT, SAID RATHER THAN IMPLIED. A `<video>` element asks
         * for byte ranges to seek; without them a browser downloads the whole
         * clip and plays it from the start, which is correct behaviour for a
         * 60 MB maximum and one less thing to get wrong. `none` tells it not
         * to try, instead of leaving it to infer from a 200 that ignored its
         * `Range` header.
         */
        'accept-ranges': 'none',
        'cache-control': 'private, no-store',
      },
    });
  } catch (cause) {
    logUnexpected('jobs.media', cause);
    return errorResponse(toApiError(cause));
  }
};
