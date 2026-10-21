import { z } from 'zod';
import { asJobId } from '@/domain';
import { loadCorrectionDocument } from '@/application/job-corrections';
import { notFound } from '@/server/api/errors';
import { writeRoute } from '@/server/api/handler';

/**
 * The CORRECTION ADDENDUM for an issued job card. BD-02, IMMUT-9, AUD-3.
 *
 * Beside the final document's own route and in the same shape, deliberately:
 * a POST although it reads (the final document route explains why), the bytes
 * base64 inside the JSON envelope, and authorisation decided by the operation
 * rather than here.
 *
 * WHO MAY OPEN IT is exactly who may open the job card it corrects —
 * `canReadFinalDocument`. Anything narrower would leave the technician who did
 * the work unable to see that EJE had since corrected it, which is the one
 * person who most needs to know.
 *
 * EVERY REFUSAL IS THE SAME 404: a correction that does not exist, one
 * belonging to another job, and one whose bytes are gone. A DAMAGED addendum
 * is the exception and refuses loudly, because it is restored from a backup
 * and never re-rendered — a re-render would be a new document carrying the
 * correction's original date.
 */
export const POST = writeRoute({
  operation: 'documents.open_correction',
  schema: z.object({}).strict(),
  handler: async (context) => {
    const jobNumber = context.params.jobNumber ?? '';
    const correctionId = context.params.correctionId ?? '';
    if (jobNumber.length === 0 || correctionId.length === 0) {
      throw notFound('That correction does not exist.');
    }

    const job =
      (await context.repos.jobs.findByJobNumber(jobNumber)) ??
      (await context.repos.jobs.findById(asJobId(jobNumber)));
    if (job === null) throw notFound('That correction does not exist.');

    const found = await loadCorrectionDocument(context.operation, job, correctionId);
    if (found === null) throw notFound('That correction does not exist.');

    return {
      fileName: found.file.fileName,
      contentType: found.file.contentType,
      base64: Buffer.from(found.file.bytes).toString('base64'),
      // So the screen can say which correction this is without a second read.
      sequence: found.correction.sequence,
    };
  },
});
