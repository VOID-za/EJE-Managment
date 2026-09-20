import { z } from 'zod';
import { loadFinalDocumentFile } from '@/application/final-document';
import { notFound } from '@/server/api/errors';
import { writeRoute } from '@/server/api/handler';

/**
 * The official final job card for a closed job.
 *
 * A POST, although it reads: `loadFinalDocumentFile` RECORDS that the document
 * was opened, and an audited read is a write. Making it a GET would also let a
 * link in an email fetch somebody's signed job card with their own cookie
 * attached.
 *
 * The bytes come back base64 inside the JSON envelope, which is what the
 * storage service already holds and what the browser's download helper already
 * takes. Production object storage replaces this with a signed URL — a change
 * behind `StorageService`, not here.
 *
 * `loadFinalDocumentFile` decides who may open it: the office, and the
 * technicians who were on the job.
 */
export const POST = writeRoute({
  operation: 'documents.open',
  schema: z.object({}).strict(),
  handler: async (context) => {
    const jobNumber = context.params.jobNumber ?? '';
    if (jobNumber.length === 0) throw notFound('That document does not exist.');

    const file = await loadFinalDocumentFile(context.operation, jobNumber);
    /*
     * Base64, because a `Uint8Array` does not survive JSON.
     *
     * Serialising it as-is produces `{"0":37,"1":80,...}` — a megabyte of
     * decimal digits that the browser then has to reassemble byte by byte. The
     * encoding is explicit here rather than left to chance.
     */
    return {
      fileName: file.fileName,
      contentType: file.contentType,
      base64: Buffer.from(file.bytes).toString('base64'),
    };
  },
});
