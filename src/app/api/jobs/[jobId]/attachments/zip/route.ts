import { NextResponse, type NextRequest } from 'next/server';
import { loadJobAttachmentsArchive } from '@/application/job-operations';
import { requireAuthenticatedActor } from '@/server/api/actor';
import { loadVisibleJob } from '@/server/api/commands/jobs';
import { errorResponse, logUnexpected, notFound, toApiError } from '@/server/api/errors';
import { safeFileName } from '@/server/api/uploads';
import { getServerRuntime } from '@/server/runtime';

/**
 * `GET /api/jobs/:jobId/attachments/zip` — every document on the job, as one
 * ZIP. JOB-ATT-2 (2 November 2026), behind the final signed job card's
 * "Download Attachments".
 *
 * Authorised exactly as one attachment is (see `[attachmentId]/route.ts`):
 * who is asking, may they see THIS job, and only then this job's own
 * documents are read. Every refusal — no such job, a job they may not see, a
 * job with no documents — is the same 404. Always a download, never inline.
 */
export const GET = async (
  request: NextRequest,
  context: { params: Promise<{ jobId: string }> },
): Promise<NextResponse> => {
  try {
    const { jobId } = await context.params;
    const actor = await requireAuthenticatedActor(request);
    const archive = await getServerRuntime().read(async ({ repos, services }) => {
      const operation = { repos, services, actor: actor.user };
      const job = await loadVisibleJob({ ...operation, operation }, jobId);
      return loadJobAttachmentsArchive(operation, job);
    });
    if (archive === null) throw notFound('This job has no attachments.');
    return new NextResponse(archive.bytes as unknown as BodyInit, {
      headers: {
        'content-type': 'application/zip',
        'content-length': String(archive.bytes.length),
        'content-disposition': `attachment; filename="${safeFileName(archive.fileName)}"`,
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
        'x-eje-attachments-included': String(archive.included),
        'x-eje-attachments-missing': String(archive.missing.length),
      },
    });
  } catch (cause) {
    logUnexpected('jobs.attachments_zip', cause);
    return errorResponse(toApiError(cause));
  }
};
