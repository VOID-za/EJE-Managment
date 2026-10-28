import { isJobAtOrPastCompletion, type Job } from '@/domain';
import {
  buildDeliveryNoteModel,
  deliveryNoteFileName,
  deliveryNoteUnavailable,
} from '@/lib/job-card/delivery-note';
import { renderDeliveryNotePdf } from '@/services/simulated/delivery-note-pdf';
import type { OperationContext } from './context';
import { audit } from './audit';
import { WorkflowError } from './errors';
import { loadJobView } from './job-view';

/**
 * PRODUCING THE COURIER'S DELIVERY NOTE. PARTS-03, PARTS-04, PARTS-05.
 *
 * A separate document from the job card, generated on request from the job as
 * it stands — never stored over, beside or instead of the issued job card,
 * whose bytes are write-once. The job is not changed. The caller must already
 * be allowed to see the job (the command loads it through the same visibility
 * rule as every job action), and the job must be a courier collection that has
 * reached completion, which is when who is collecting is recorded. Each one
 * produced is on the job's activity trail.
 */
export const generateDeliveryNote = async (
  context: OperationContext,
  job: Job,
): Promise<{ fileName: string; contentType: 'application/pdf'; base64: string }> => {
  const unavailable = deliveryNoteUnavailable(job);
  if (unavailable !== null) {
    throw new WorkflowError(`${job.jobNumber} has no delivery note.`, [
      { code: 'delivery_note_not_applicable', message: unavailable },
    ]);
  }
  if (!isJobAtOrPastCompletion(job.status)) {
    throw new WorkflowError(`${job.jobNumber} has not been completed yet.`, [
      {
        code: 'job_not_completed',
        message: 'The delivery note is produced at the collection, once the work is finished.',
      },
    ]);
  }
  const view = await loadJobView(context.repos, job.jobNumber, context.actor);
  if (view === null) throw new WorkflowError(`${job.jobNumber} could not be loaded.`);
  const generatedAt = context.services.clock.now();
  const model = buildDeliveryNoteModel(view, generatedAt);
  const rendered = renderDeliveryNotePdf(model);
  await audit(context, {
    jobId: job.id,
    type: 'delivery_note_generated',
    summary: `Delivery note produced for ${job.jobNumber}`,
    detail: `${model.items.length} item line${model.items.length === 1 ? '' : 's'}, no prices. The job card is unchanged.`,
  });
  return {
    fileName: deliveryNoteFileName(job),
    contentType: 'application/pdf',
    base64: Buffer.from(rendered.bytes).toString('base64'),
  };
};
