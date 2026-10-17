import { NextResponse, type NextRequest } from 'next/server';
import { readJobMedia } from '@/application/job-operations';
import { requireAuthenticatedActor } from '@/server/api/actor';
import { loadVisibleJob } from '@/server/api/commands/jobs';
import { errorResponse, logUnexpected, notFound, toApiError } from '@/server/api/errors';
import { PHOTO_CONTENT_TYPES, safeFileName } from '@/server/api/uploads';
import { getServerRuntime } from '@/server/runtime';

/**
 * `GET /api/jobs/:jobId/media/:attachmentId` — the photograph itself. PWA-3.
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
 *     only — there is no SVG and no HTML in it, so there is no document to
 *     execute. A row that somehow holds anything else is refused below rather
 *     than served;
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
    // Belt and braces: capture sniffs the bytes, and this refuses to serve a
    // row that is not an image even so. One of the two has to be the last word,
    // and it should be the one at the moment of serving.
    if (!PHOTO_CONTENT_TYPES.includes(found.document.contentType)) {
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
        'cache-control': 'private, no-store',
      },
    });
  } catch (cause) {
    logUnexpected('jobs.media', cause);
    return errorResponse(toApiError(cause));
  }
};
