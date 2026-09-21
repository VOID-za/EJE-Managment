import { NextResponse, type NextRequest } from 'next/server';
import { readJobAttachment } from '@/application/job-operations';
import { requireAuthenticatedActor } from '@/server/api/actor';
import { loadVisibleJob } from '@/server/api/commands/jobs';
import { errorResponse, logUnexpected, notFound, toApiError } from '@/server/api/errors';
import { safeFileName } from '@/server/api/uploads';
import { getServerRuntime } from '@/server/runtime';

/**
 * `GET /api/jobs/:jobId/attachments/:attachmentId` — the file itself.
 *
 * AUTHORIZATION HAPPENS BEFORE RETRIEVAL, and the storage key is never part of
 * it. The sequence is: who is asking (session), may they see this job at all
 * (`loadVisibleJob`, which is the same Decision 5 rule every job read goes
 * through), and is this attachment on THAT job. Only then is anything read out
 * of storage.
 *
 * WHAT THAT CLOSES. Changing the job id in the URL reaches a job the actor may
 * not see and answers 404. Guessing an attachment id reaches an attachment that
 * is not on this job and answers 404. Holding a storage key is worth nothing:
 * there is no route that takes one, and `resolveUrl` returns something a
 * browser cannot fetch. A customer's document has no public address.
 *
 * EVERY REFUSAL IS THE SAME 404. A job that does not exist, a job this actor
 * may not read, an attachment on another job and an attachment whose bytes were
 * never stored are indistinguishable from outside — which is what stops the
 * endpoint being used to ask which ids are real.
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
      return readJobAttachment(operation, job, attachmentId);
    });

    if (found === null) throw notFound('That attachment does not exist.');

    const fileName = safeFileName(found.attachment.fileName);
    return new NextResponse(found.document.bytes as unknown as BodyInit, {
      headers: {
        'content-type': found.document.contentType,
        'content-length': String(found.document.bytes.length),
        /*
         * ALWAYS AN ATTACHMENT, never inline.
         *
         * A PDF or an image rendered in the page would run in this origin's
         * context, and the one thing that must not happen to a file somebody
         * else uploaded is that the browser treats it as part of this
         * application. Downloading it is the safe reading of every type here.
         */
        'content-disposition': `attachment; filename="${fileName}"`,
        // The sniffed type is the truth; the browser must not go looking for a
        // more interesting one.
        'x-content-type-options': 'nosniff',
        // A customer's document does not belong in a shared cache, and a
        // signed-out browser must not still hold it.
        'cache-control': 'private, no-store',
      },
    });
  } catch (cause) {
    logUnexpected('jobs.attachment', cause);
    return errorResponse(toApiError(cause));
  }
};
