import { canOpenDocumentFile } from '@/application/library-operations';
import { ApiError } from '@/server/api/errors';
import { downloadRoute } from '@/server/api/handler';
import { asDocumentId } from '@/domain';

/**
 * `GET /api/library/:documentId/file` — the stored document itself. LIB-5.
 *
 * WHY THIS EXISTS. The library could hold a file and not hand it back: the
 * upload path stores the bytes, the index reads them, and the screen offered a
 * disabled *Download (simulated)* button. A manual nobody can open on site is
 * not a technical library — it is a list of manuals EJE own.
 *
 * AUTHORISATION IS `canOpenDocumentFile`, which is the library screen's own
 * three-way rule in one place: a current or archived revision for anybody who
 * may read the library, and a `pending_approval` one only for the office that
 * has to read it to approve it, or the person who uploaded it. A refusal is a
 * 404 and not a 403, deliberately — the same answer as a document that does not
 * exist, so the response cannot be used to ask which documents are pending.
 *
 * A RECORD WITH NO BYTES IS AN HONEST 404. Every seeded document is metadata:
 * there was no upload path when the demonstration data was written, so there is
 * nothing to serve and the message says exactly that rather than an empty file.
 *
 * The storage key never reaches a client. It is read from the record here, on
 * the server, after the check — a key is not a credential and must not become
 * one.
 */
export const GET = downloadRoute('library.file', async (context) => {
  const documentId = asDocumentId(context.params.documentId ?? '');
  const document = await context.repos.documents.findById(documentId);

  if (document === null || !canOpenDocumentFile(context.actor.user, document)) {
    throw new ApiError('not_found', 'That document could not be found.');
  }

  const stored = await context.services.storage.getDocument(document.storageKey);
  if (stored === null) {
    throw new ApiError('not_found', 'There is no file stored against that document.', [
      {
        code: 'no_file_stored',
        message:
          'This record describes a document that was never uploaded — every demonstration document is metadata only. Upload the PDF and it will be stored, indexed and downloadable.',
      },
    ]);
  }

  /*
   * THE REVISION IS NAMED IN THE ANSWER. MASTER SCOPE LIB-5, IMMUT-*.
   *
   * The domain's unit is a revision, and this route is keyed by the revision's
   * own id, so it CANNOT serve a newer one — but the screen cannot see that,
   * and a preview that silently showed revision 2.0 while the technician
   * believed they were reading 1.0 would be the worst kind of wrong on a
   * document somebody works from. So the answer says which revision and which
   * version it is, and the preview refuses to render bytes whose revision is
   * not the one it asked for.
   *
   * Neither header is a secret or a key: the revision id is already in the URL
   * the client used, and the version is on the screen beside it.
   */
  return {
    fileName: document.fileName,
    contentType: stored.contentType.length > 0 ? stored.contentType : 'application/pdf',
    body: stored.bytes,
    headers: {
      'X-EJE-Document-Revision': document.id,
      'X-EJE-Document-Version': document.version,
    },
  };
});
