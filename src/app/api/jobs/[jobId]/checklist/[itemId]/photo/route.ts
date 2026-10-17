import { z } from 'zod';
import { addChecklistPhoto } from '@/application/job-operations';
import { loadVisibleJob } from '@/server/api/commands/jobs';
import { ApiError } from '@/server/api/errors';
import { uploadRoute } from '@/server/api/handler';
import { MAX_UPLOAD_BYTES, validatePhotoUpload } from '@/server/api/uploads';

const FIELDS = z.object({ caption: z.string().max(500).optional() }).strict();

/**
 * `POST /api/jobs/:jobId/checklist/:itemId/photo` — evidence against one
 * checklist question. CHK-EVIDENCE-1.
 *
 * ITS OWN ROUTE RATHER THAN THE MEDIA ROUTE WITH A FIELD, because it is a
 * different act with a different consequence: a job photograph is evidence of
 * the work, while this one gates `completeChecklist` on a job type whose items
 * are marked `photoRequired`. Naming the operation means the audit line, the
 * authorisation and the refusal all speak about the thing that happened.
 *
 * The order is the same as every other upload here:
 *
 *   same-origin → authenticate → bound the body → is this job visible to this
 *   actor → may they capture on it → is the checklist started → sniff the
 *   bytes → store the bytes → record the attachment → commit
 *
 * `loadVisibleJob` answers 404 for a job this actor may not see, so evidence
 * cannot be pushed onto another technician's checklist by editing the URL.
 * `addChecklistPhoto` then applies `assertEditable` and `assertCanCapture` —
 * the same rules every capture on a job goes through, so a signed job card
 * refuses this as it refuses everything else.
 *
 * THE ITEM ID IS NOT VALIDATED AGAINST THE TEMPLATE HERE, and that is
 * deliberate: the response is keyed by item id on the job's own checklist
 * instance, whose `templateVersion` is fixed, and the PostgreSQL schema has
 * `checklist_answers.question_id` referencing `checklist_questions` — so an id
 * that is not on this job's checklist is refused by the database rather than by
 * a second copy of the rule here.
 */
export const POST = uploadRoute({
  operation: 'jobs.add_checklist_photo',
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

    const itemId = context.params.itemId ?? '';
    if (itemId.length === 0) {
      throw new ApiError('validation_failed', 'That photograph could not be attached.', [
        { code: 'item_missing', message: 'The checklist item was not named.' },
      ]);
    }

    const parsed = FIELDS.safeParse(
      context.form.has('caption') ? { caption: context.form.get('caption') } : {},
    );
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

    const saved = await addChecklistPhoto(context.operation, job, itemId, {
      fileName: file.fileName,
      contentType: file.contentType,
      bytes: file.bytes,
      ...(parsed.data.caption === undefined ? {} : { caption: parsed.data.caption }),
    });

    const response = (saved.checklist?.responses ?? []).find(
      (candidate) => candidate.itemId === itemId,
    );

    /*
     * The evidence on THIS item as it now stands — not the whole checklist, and
     * never a storage key. The runner addresses each photograph by its
     * attachment id through the authenticated media route.
     */
    return {
      itemId,
      photos: (response?.photos ?? []).map((photo) => ({
        id: photo.id,
        fileName: photo.fileName,
        caption: photo.caption,
        sizeBytes: photo.sizeBytes,
        uploadedAt: photo.uploadedAt,
      })),
    };
  },
});
