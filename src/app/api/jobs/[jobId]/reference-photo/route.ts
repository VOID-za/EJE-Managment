import { addDeliveryNoteReferencePhoto } from '@/application/job-operations';
import { loadVisibleJob } from '@/server/api/commands/jobs';
import { uploadRoute } from '@/server/api/handler';
import { MAX_UPLOAD_BYTES, validatePhotoUpload } from '@/server/api/uploads';

/**
 * `POST /api/jobs/:jobId/reference-photo` — the office's photo of the delivery
 * note that came in with a Test & Repair job's parts. TR-REF-PHOTO-1.
 *
 * The same order as every upload: same-origin → authenticate → bound the body
 * → may this actor see this job (404 if not, which confirms nothing) → sniff
 * the BYTES as a photograph (a renamed PDF is refused on what it is; the size
 * limit applies) → store → record as an INTERNAL reference
 * (`addDeliveryNoteReferencePhoto`, which also decides who may).
 */
export const POST = uploadRoute({
  operation: 'jobs.add_reference_photo',
  maxBytes: MAX_UPLOAD_BYTES,
  handler: async (context) => {
    const job = await loadVisibleJob(
      { repos: context.repos, services: context.services, actor: context.actor.user, operation: context.operation },
      context.params.jobId ?? '',
    );
    const file = validatePhotoUpload({
      fileName: context.file.name,
      declaredContentType: context.file.type,
      bytes: new Uint8Array(await context.file.arrayBuffer()),
    });
    const saved = await addDeliveryNoteReferencePhoto(context.operation, job, {
      fileName: file.fileName,
      contentType: file.contentType,
      bytes: file.bytes,
    });
    // Never the storage key: the download route is the only way to the bytes.
    const photo = saved.photos[saved.photos.length - 1]!;
    return { id: photo.id, fileName: photo.fileName, caption: photo.caption, visibility: photo.visibility, purpose: photo.purpose };
  },
});
