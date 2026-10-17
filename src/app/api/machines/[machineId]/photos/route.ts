import { z } from 'zod';
import { addMachinePhoto } from '@/application/machine-operations';
import { asJobId, asMachineId } from '@/domain';
import { ApiError, notFound } from '@/server/api/errors';
import { uploadRoute } from '@/server/api/handler';
import { MAX_UPLOAD_BYTES, validatePhotoUpload } from '@/server/api/uploads';

const FIELDS = z
  .object({
    caption: z.string().max(500).optional(),
    /**
     * The job that makes this photograph part of the technician's work. BD-14.
     *
     * A CLAIM, like every other field: the server checks that the job exists,
     * is on this machine, is assigned to this actor and has not left the
     * workflow. Sending one buys nothing if any of that is false.
     */
    jobId: z.string().min(1).max(100).optional(),
  })
  .strict();

/**
 * `POST /api/machines/:machineId/photos` — a photograph of the machine itself.
 * MACH-PHOTO-1.
 *
 * SEPARATE FROM JOB MEDIA, for the reason the tables are separate: a photograph
 * of a rating plate belongs to the MACHINE and stays useful across every job
 * ever done on it, while a photograph of a burnt contactor belongs to the job
 * that found it.
 *
 * `addMachinePhoto` holds the register's permission rules and this route adds
 * nothing to them. *Amended for BD-14:* the office may photograph any machine;
 * a technician may photograph their own unapproved submission, or an OFFICIAL
 * machine from a live job of theirs that is on it — named in `jobId` and
 * verified against the job, not taken on trust. A photograph still cannot
 * change machine data or approval; see that function.
 */
export const POST = uploadRoute({
  operation: 'machines.add_photo',
  maxBytes: MAX_UPLOAD_BYTES,
  handler: async (context) => {
    const machine = await context.repos.machines.findById(
      asMachineId(context.params.machineId ?? ''),
    );
    if (machine === null) throw notFound('That machine does not exist.');

    const parsed = FIELDS.safeParse({
      ...(context.form.has('caption') ? { caption: context.form.get('caption') } : {}),
      ...(context.form.has('jobId') ? { jobId: context.form.get('jobId') } : {}),
    });
    if (!parsed.success) {
      throw new ApiError('validation_failed', 'That photograph could not be attached.', [
        { code: 'invalid_field', message: 'The caption was not understood.' },
      ]);
    }

    const file = validatePhotoUpload({
      fileName: context.file.name,
      declaredContentType: context.file.type,
      bytes: new Uint8Array(await context.file.arrayBuffer()),
    });

    const saved = await addMachinePhoto(
      context.operation,
      machine,
      {
        fileName: file.fileName,
        caption: parsed.data.caption?.trim() ?? '',
        contentType: file.contentType,
        bytes: file.bytes,
      },
      parsed.data.jobId === undefined ? {} : { jobId: asJobId(parsed.data.jobId) },
    );

    /*
     * The photographs as they now stand, and the approval state with them — so
     * a screen can say "still awaiting approval" without a second request.
     * Never a storage key.
     */
    return {
      approval: saved.approval,
      photos: saved.photos.map((photo) => ({
        id: photo.id,
        fileName: photo.fileName,
        caption: photo.caption,
        sizeBytes: photo.sizeBytes,
        uploadedAt: photo.uploadedAt,
      })),
    };
  },
});
