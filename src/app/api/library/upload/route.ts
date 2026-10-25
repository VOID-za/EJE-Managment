import { z } from 'zod';
import { uploadDocument } from '@/application/library-operations';
import { parseWith, uploadRoute } from '@/server/api/handler';
import { MAX_UPLOAD_BYTES, validateUpload } from '@/server/api/uploads';
import { ApiError } from '@/server/api/errors';

/**
 * `POST /api/library/upload` — a document WITH ITS FILE. MASTER SCOPE LIB-5.
 *
 * WHAT THIS REPLACES. `POST /api/library` records metadata and a storage key
 * for a file nobody ever sent: the dialog typed a file name and asserted a page
 * count. A library of records pointing at files that do not exist cannot be
 * downloaded, let alone searched, which is why the first part of LIB-5 is an
 * upload rather than an indexer.
 *
 * THE ORDER, and every step of it matters:
 *
 *   same-origin → authenticate → bound the body → validate the FIELDS →
 *   sniff the BYTES → store the bytes → record the document →
 *   extract and index its text → commit
 *
 * `validateUpload` measures and sniffs, so what is stored is the server's
 * finding and never the browser's claim; a PDF is required because the
 * extractor reads PDFs and a library of images would be a library nobody can
 * search. `uploadDocument` then applies the ordinary approval rule — a
 * technician's upload lands `pending_approval` and is not reference material,
 * and is not returned by the search, until a Master approves it.
 *
 * An unreadable or scanned PDF is NOT refused: it is stored and recorded as
 * not searchable, with the reason. The office may have nothing else, and a
 * document the library holds and says it cannot search is worth more than one
 * it refused at the door.
 */
const fields = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).default(''),
    documentType: z.enum([
      'machine_manual',
      'electrical_diagram',
      'service_manual',
      'safety_procedure',
      'work_procedure',
      'datasheet',
    ]),
    manufacturer: z.string().max(120).default(''),
    machineModel: z.string().max(120).default(''),
    version: z.string().max(40).default('1.0'),
    tags: z.string().max(400).default(''),
  })
  .strict();

export const POST = uploadRoute({
  operation: 'library.upload',
  maxBytes: MAX_UPLOAD_BYTES,
  handler: async (context) => {
    const input = parseWith(fields, {
      name: context.form.get('name') ?? '',
      description: context.form.get('description') ?? '',
      documentType: context.form.get('documentType') ?? 'machine_manual',
      manufacturer: context.form.get('manufacturer') ?? '',
      machineModel: context.form.get('machineModel') ?? '',
      version: context.form.get('version') ?? '1.0',
      tags: context.form.get('tags') ?? '',
    });

    const file = validateUpload({
      fileName: context.file.name,
      declaredContentType: context.file.type,
      bytes: new Uint8Array(await context.file.arrayBuffer()),
    });

    if (file.contentType !== 'application/pdf') {
      throw new ApiError(
        'validation_failed',
        'The technical library takes PDF documents.',
        [
          {
            code: 'not_a_pdf',
            message:
              'A manual has to be a PDF to be stored and searched. A photograph of a page belongs on the job, not in the library.',
          },
        ],
      );
    }

    const { document, index } = await uploadDocument(context.operation, {
      name: input.name,
      description: input.description,
      documentType: input.documentType,
      manufacturer: input.manufacturer,
      machineModel: input.machineModel,
      version: input.version,
      tags: input.tags
        .split(',')
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0),
      file,
    });

    /*
     * The record, and the honest state of its text.
     *
     * The storage key is deliberately NOT returned: a key is not a way in, and
     * the client has no reason to hold one (see the download route).
     */
    return {
      document: {
        id: document.id,
        name: document.name,
        status: document.status,
        version: document.version,
        fileName: document.fileName,
        fileSizeBytes: document.fileSizeBytes,
        pageCount: document.pageCount,
        /*
         * WHOSE DOCUMENT THIS IS, in the answer to the upload itself.
         * October mandate §1: an upload produces a GENUINE record, and the
         * screen that just made one should not have to re-fetch the list to
         * find out that it is not demonstration data.
         */
        provenance: document.provenance,
        storedFile: document.fileSizeBytes > 0,
      },
      index: {
        state: index.state,
        source: index.source,
        characters: index.characters,
        pages: index.pages,
        // N of M, LIB-TEXT-1 (#70): the screen that just indexed a document
        // says how much of it is searchable, not only whether.
        pagesIndexed: index.pagesIndexed,
        truncated: index.truncated,
        failureReason: index.failureReason,
      },
    };
  },
});
