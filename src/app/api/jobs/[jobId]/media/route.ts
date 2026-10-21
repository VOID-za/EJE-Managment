import { z } from 'zod';
import { addMedia } from '@/application/job-operations';
import { loadVisibleJob } from '@/server/api/commands/jobs';
import { ApiError } from '@/server/api/errors';
import { uploadRoute } from '@/server/api/handler';
import {
  MAX_VIDEO_BYTES,
  validatePhotoUpload,
  validateVideoUpload,
} from '@/server/api/uploads';

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
    /**
     * WHICH OF THE TWO THIS IS. MEDIA-5.
     *
     * Absent means `photo`, so every client written before video existed keeps
     * working unchanged. It decides the validator and the limit, and nothing
     * else: a `kind` of `video` on a JPEG is refused by the sniffer, not
     * believed.
     */
    kind: z.enum(['photo', 'video']).optional(),
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
 * A PHOTOGRAPH OR A VIDEO, AND THE BYTES DECIDE WHICH. MEDIA-5.
 *
 * `kind` chooses the validator and the size limit; the SNIFFER chooses what
 * the file actually is. So `kind=video` on a JPEG is refused, and so is
 * `kind=photo` on an MP4 — the field selects a rule, it does not assert a
 * fact. A PDF cannot arrive by either route and be listed as evidence.
 *
 * THE ROUTE'S OWN BOUND IS THE LARGER OF THE TWO, because a route takes one
 * `maxBytes` and it is checked against `Content-Length` before the body is
 * read. The photograph path is still held to 25 MB by `validatePhotoUpload`
 * once the bytes have arrived, so the looser outer bound cannot let an
 * oversized photograph through — it only decides how much is read before
 * anybody looks.
 *
 * WHAT VIDEO DOES NOT DO, and it is deliberate: it does not appear on the
 * customer's job card. That document is a PDF and a PDF cannot carry a video,
 * so listing one on it would promise the customer something they cannot open.
 * The MEDIA-1 visibility question is still asked at capture and recorded, so
 * the answer is there the day EJE decide how a customer receives one — see
 * `docs/SCOPE.md`, MEDIA-5.
 *
 * NOT IDEMPOTENT, by the same reasoning as the document route: a technician who
 * taps capture twice has two photographs, and replaying the first would discard
 * a deliberate second shot.
 */
export const POST = uploadRoute({
  operation: 'jobs.add_media',
  maxBytes: MAX_VIDEO_BYTES,
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
      ...(context.form.has('kind') ? { kind: context.form.get('kind') } : {}),
    });
    if (!parsed.success) {
      throw new ApiError('validation_failed', 'That photograph could not be attached.', [
        { code: 'invalid_field', message: 'The capture details were not understood.' },
      ]);
    }

    const kind = parsed.data.kind ?? 'photo';
    const candidate = {
      fileName: context.file.name,
      declaredContentType: context.file.type,
      bytes: new Uint8Array(await context.file.arrayBuffer()),
    };
    const file = kind === 'video' ? validateVideoUpload(candidate) : validatePhotoUpload(candidate);

    /*
     * A VIDEO IS FILED FOR THE OFFICE, AND THE SERVER DECIDES THAT, NOT THE
     * CLIENT. MEDIA-5.
     *
     * The panel does not offer the choice, and that is not enough: a request
     * can ask for whatever it likes. `customer_facing` on a video would be a
     * promise nobody can keep — the job card is a PDF and cannot carry one —
     * and WHICH answer is right is EJE's to give rather than this route's. So
     * the conservative reading is applied here: internal, which is what the
     * customer receives today. See docs/SCOPE.md, MEDIA-5.
     */
    const visibility = kind === 'video' ? 'internal' : parsed.data.visibility;

    const saved = await addMedia(context.operation, job, {
      kind,
      fileName: file.fileName,
      contentType: file.contentType,
      bytes: file.bytes,
      caption: parsed.data.caption?.trim() ?? '',
      ...(visibility === undefined ? {} : { visibility }),
    });

    /*
     * The photographs as they now stand — and deliberately not the storage
     * keys. The screen addresses a photograph by its attachment id through the
     * authenticated route beside this one; a key is not a way in and the client
     * has no use for one.
     */
    const describe = (attachment: (typeof saved.photos)[number]) => ({
      id: attachment.id,
      fileName: attachment.fileName,
      caption: attachment.caption,
      visibility: attachment.visibility,
      sizeBytes: attachment.sizeBytes,
      uploadedAt: attachment.uploadedAt,
    });

    return { photos: saved.photos.map(describe), videos: saved.videos.map(describe) };
  },
});
