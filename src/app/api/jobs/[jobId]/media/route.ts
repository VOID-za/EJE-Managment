import { z } from 'zod';
import { addMedia } from '@/application/job-operations';
import { loadVisibleJob } from '@/server/api/commands/jobs';
import { ApiError } from '@/server/api/errors';
import { uploadRoute } from '@/server/api/handler';
import { MAX_UPLOAD_BYTES, validatePhotoUpload } from '@/server/api/uploads';

/**
 * The fields that travel with the photograph.
 *
 * A multipart part is a string like any other request value, so it is parsed
 * and validated here rather than trusted. `visibility` is optional and absent
 * means customer-facing — MEDIA-1's default, unchanged.
 */
const FIELDS = z
  .object({
    caption: z.string().max(500).optional(),
    visibility: z.enum(['customer_facing', 'internal']).optional(),
  })
  .strict();

/**
 * `POST /api/jobs/:jobId/media` — a photograph, bytes and all. PWA-3, CR-09
 * Phase 3.
 *
 * THE ONE CHANGE THAT MAKES CAPTURE REAL. Until this route existed the camera
 * button recorded a row and uploaded nothing; the tile on the job card was a
 * placeholder and the job card the customer signed cited evidence that had
 * never been stored. The order here is the same as every other upload:
 *
 *   same-origin → authenticate → bound the body → is this job visible to this
 *   actor → may they capture on it → sniff the bytes → store the bytes →
 *   record the row → commit
 *
 * PHOTOGRAPHS ONLY. `validatePhotoUpload` refuses anything whose sniffed type
 * is not a raster image, so the document path's PDF cannot arrive here and be
 * listed as a photograph.
 *
 * NO VIDEO. The route accepts no `kind`: every upload is a photograph. Video
 * capture is MEDIA-5, which is an undecided business question — duration,
 * size and whether a customer ever receives one — and a route that quietly
 * accepted an MP4 would be deciding it. See `docs/SCOPE.md`.
 *
 * NOT IDEMPOTENT, by the same reasoning as the document route: a technician who
 * taps capture twice has two photographs, and replaying the first would discard
 * a deliberate second shot.
 */
export const POST = uploadRoute({
  operation: 'jobs.add_media',
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

    const parsed = FIELDS.safeParse({
      ...(context.form.has('caption') ? { caption: context.form.get('caption') } : {}),
      ...(context.form.has('visibility') ? { visibility: context.form.get('visibility') } : {}),
    });
    if (!parsed.success) {
      throw new ApiError('validation_failed', 'That photograph could not be attached.', [
        { code: 'invalid_field', message: 'The capture details were not understood.' },
      ]);
    }

    const file = validatePhotoUpload({
      fileName: context.file.name,
      declaredContentType: context.file.type,
      bytes: new Uint8Array(await context.file.arrayBuffer()),
    });

    const saved = await addMedia(context.operation, job, {
      kind: 'photo',
      fileName: file.fileName,
      contentType: file.contentType,
      bytes: file.bytes,
      caption: parsed.data.caption?.trim() ?? '',
      ...(parsed.data.visibility === undefined ? {} : { visibility: parsed.data.visibility }),
    });

    /*
     * The photographs as they now stand — and deliberately not the storage
     * keys. The screen addresses a photograph by its attachment id through the
     * authenticated route beside this one; a key is not a way in and the client
     * has no use for one.
     */
    return {
      photos: saved.photos.map((photo) => ({
        id: photo.id,
        fileName: photo.fileName,
        caption: photo.caption,
        visibility: photo.visibility,
        sizeBytes: photo.sizeBytes,
        uploadedAt: photo.uploadedAt,
      })),
    };
  },
});
