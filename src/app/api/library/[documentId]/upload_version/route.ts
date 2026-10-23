import { z } from 'zod';
import { asDocumentId } from '@/domain';
import { uploadDocumentVersion } from '@/application/library-operations';
import { parseWith, uploadRoute } from '@/server/api/handler';
import { ApiError, notFound } from '@/server/api/errors';
import { MAX_UPLOAD_BYTES, validateUpload } from '@/server/api/uploads';

/**
 * `POST /api/library/:documentId/upload_version` — a new revision WITH ITS
 * FILE. MASTER SCOPE LIB-5, LIB-REV-1.
 *
 * WHAT THIS CLOSES. `POST /api/library/:documentId/add_version` records a
 * revision and generates a storage key, and nothing ever sent the bytes: the
 * library's only upload route creates a NEW DOCUMENT. A Master revising a
 * manual therefore produced a `current` revision that could not be downloaded
 * and could not be searched, and the download route's own refusal told them to
 * "upload the PDF" with no way to do it. The metadata-only route is kept —
 * EJE's library has records that are metadata by design — and this is the one
 * that carries a file.
 *
 * THE ORDER, as every other upload path in this system:
 *
 *   same-origin → authenticate → bound the body → validate the FIELDS →
 *   does this document exist → sniff the BYTES → archive the previous revision
 *   and record the new one → store the bytes → read them back → index the
 *   text → commit
 *
 * A PDF IS REQUIRED, like the first upload: the extractor reads PDFs, and a
 * revision of a manual that is a photograph of a page is a revision nobody can
 * search. An unreadable or scanned PDF is NOT refused — it is stored and
 * recorded as not searchable with the reason, because the office may have
 * nothing else.
 */
const fields = z
  .object({
    version: z.string().min(1).max(40),
    description: z.string().max(2000).default(''),
  })
  .strict();

export const POST = uploadRoute({
  operation: 'library.upload_version',
  maxBytes: MAX_UPLOAD_BYTES,
  handler: async (context) => {
    const input = parseWith(fields, {
      version: context.form.get('version') ?? '',
      description: context.form.get('description') ?? '',
    });

    const documentId = asDocumentId(context.params.documentId ?? '');
    const previous = await context.repos.documents.findById(documentId);
    /*
     * 404 BEFORE ANYTHING IS STORED, and before the capability is tested by
     * the operation: a document this actor could not otherwise enumerate must
     * not be confirmed to exist by an upload attempt.
     */
    if (previous === null) throw notFound('That document does not exist.');

    const file = validateUpload({
      fileName: context.file.name,
      declaredContentType: context.file.type,
      bytes: new Uint8Array(await context.file.arrayBuffer()),
    });

    if (file.contentType !== 'application/pdf') {
      throw new ApiError('validation_failed', 'The technical library takes PDF documents.', [
        {
          code: 'not_a_pdf',
          message:
            'A manual has to be a PDF to be stored and searched. A photograph of a page belongs ' +
            'on the job, not in the library.',
        },
      ]);
    }

    const { document, index } = await uploadDocumentVersion(context.operation, previous, {
      version: input.version,
      description: input.description,
      file,
    });

    // The storage key stays on the server: the file route resolves it after
    // deciding who is asking, and a key is not a way in.
    const { storageKey: _storageKey, ...rest } = document;
    return { document: rest, index };
  },
});
