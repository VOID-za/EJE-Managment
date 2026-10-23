import { asCustomerId } from '@/domain';
import { attachCustomerDocument, listCustomerDocuments } from '@/application/customer-documents';
import { readRoute, uploadRoute } from '@/server/api/handler';
import { MAX_UPLOAD_BYTES, validateUpload } from '@/server/api/uploads';

/**
 * `GET /api/customers/:customerId/documents` — the customer's filed paperwork.
 * `POST` — attach a file to it. October mandate §4.
 *
 * AUTHORISATION IS THE OPERATION'S, not this file's, and the two halves are no
 * longer the same rule: `listCustomerDocuments` needs `customers.view` since
 * CUST-DOC-2 (the owner decided a technician may view and download a
 * customer's paperwork) and `attachCustomerDocument` still needs
 * `customers.manage`. Both reasons are written down where the rules live
 * rather than repeated here — a rule stated twice is a rule that will
 * disagree with itself.
 *
 * THE ORDER on an upload, and every step of it matters:
 *
 *   same-origin → authenticate → bound the body → sniff the BYTES →
 *   does this customer exist and may they take a document →
 *   store the bytes → read them back → record the row → commit
 *
 * `validateUpload` measures and sniffs, so what is stored is the server's
 * finding and never the browser's claim — a file called `quote.pdf` that is
 * really an executable is refused here.
 */
export const GET = readRoute('customers.documents', async (context) => {
  // A read performs no operation, so one is composed from the unit of work and
  // the SESSION's actor. The actor is never taken from the request.
  const operation = {
    repos: context.repos,
    services: context.services,
    actor: context.actor.user,
  };
  /*
   * `?includeArchived=true` — the office reviewing what it took off the
   * screen. Withdrawn, never deleted, is the register's rule, and until this
   * was wired a withdrawn document could never be looked at again by anybody:
   * the row and the bytes were kept for an audit that had no way to ask for
   * them. The OPERATION decides who may (the office), so a technician passing
   * it is answered with the live list rather than refused — see
   * `listCustomerDocuments`.
   */
  const documents = await listCustomerDocuments(
    operation,
    asCustomerId(context.params.customerId ?? ''),
    { includeArchived: context.request.nextUrl.searchParams.get('includeArchived') === 'true' },
  );
  // The storage key stays on the server: the download route resolves it after
  // deciding who is asking, and a key is not a way in.
  return {
    documents: documents.map(({ storageKey: _storageKey, ...rest }) => rest),
  };
});

export const POST = uploadRoute({
  operation: 'customers.attach_document',
  maxBytes: MAX_UPLOAD_BYTES,
  handler: async (context) => {
    const file = validateUpload({
      fileName: context.file.name,
      declaredContentType: context.file.type,
      bytes: new Uint8Array(await context.file.arrayBuffer()),
    });

    const saved = await attachCustomerDocument(
      context.operation,
      asCustomerId(context.params.customerId ?? ''),
      { ...file, caption: context.caption },
    );

    const { storageKey: _storageKey, ...document } = saved;
    return { document };
  },
});
