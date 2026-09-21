import { attachDocument } from '@/application/job-operations';
import { loadVisibleJob } from '@/server/api/commands/jobs';
import { uploadRoute } from '@/server/api/handler';
import { MAX_UPLOAD_BYTES, validateUpload } from '@/server/api/uploads';

/**
 * `POST /api/jobs/:jobId/attachments` — attach a document to a job.
 *
 * THE ORDER, and every step of it matters:
 *
 *   same-origin → authenticate → bound the body → is this job visible to this
 *   actor at all → may they change it → sniff the bytes → store the bytes →
 *   record the row → commit
 *
 * `loadVisibleJob` answers 404 for a job this actor may not see, so an
 * attachment cannot be pushed onto another technician's work or another
 * customer's job by editing the URL — and the refusal does not confirm that
 * the job exists. `attachDocument` then applies the ordinary rule about who
 * may change a job at its current stage.
 *
 * The file itself is never trusted: `validateUpload` measures the bytes and
 * sniffs them, and what is stored is the server's finding rather than the
 * browser's claim.
 */
export const POST = uploadRoute({
  operation: 'jobs.attach_document',
  maxBytes: MAX_UPLOAD_BYTES,
  handler: async (context) => {
    const job = await loadVisibleJob(
      {
        repos: context.repos,
        services: context.services,
        actor: context.actor.user,
        operation: context.operation,
      },
      context.params.jobId ?? '',
    );

    const file = validateUpload({
      fileName: context.file.name,
      declaredContentType: context.file.type,
      bytes: new Uint8Array(await context.file.arrayBuffer()),
    });

    const saved = await attachDocument(context.operation, job, {
      ...file,
      caption: context.caption,
    });

    // The attachments as they now stand. Deliberately not the storage keys —
    // see the download route: a key is not a way in, and the client has no
    // reason to hold one.
    return {
      attachments: saved.attachments.map((attachment) => ({
        id: attachment.id,
        fileName: attachment.fileName,
        caption: attachment.caption,
        sizeBytes: attachment.sizeBytes,
        uploadedAt: attachment.uploadedAt,
      })),
    };
  },
});
