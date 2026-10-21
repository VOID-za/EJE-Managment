import { can, type CustomerDocument, type CustomerId } from '@/domain';
import type { OperationContext } from './context';
import { WorkflowError } from './errors';
import { audit } from './audit';
import { StorageIntegrityFailed, type StoredDocument, type UploadedFile } from '@/services/ports';
import { storeAndMeasure } from './stored-file';

/**
 * FILES ATTACHED TO A CUSTOMER. October mandate §4.
 *
 * WHAT WAS MISSING. Jobs, machines, checklists and the technical library all
 * carry files. A customer carried none — so the signed service agreement, the
 * credit application, the site induction certificate and the written
 * purchase-order authority lived in somebody's mailbox, which is where a
 * document goes to be unfindable the week somebody leaves.
 *
 * WHO MAY, AND WHY IT IS THE OFFICE. Uploading and reading both need
 * `customers.manage`, which is the office's capability over the register
 * itself. That is the narrow answer and it is deliberate: a customer's
 * commercial paperwork is not field reference material, and the scope says
 * nothing about technicians reading it. Widening it later is one line; a
 * technician who has already read a customer's credit application cannot be
 * un-shown it.
 *
 *   NOT A GUESS DRESSED AS A RULE: whether a technician should see a specific
 *   customer document — a site induction certificate is the obvious candidate
 *   — is a question for EJE, recorded in `docs/outstanding-scope.md` rather
 *   than answered here.
 *
 * THE BYTES LAND FIRST, as everywhere else in this system (MEDIA-6,
 * CHK-EVIDENCE-1): `storeUpload` writes them or raises, and only then is the
 * row written. A row pointing at bytes that are not there is the failure that
 * ordering exists to prevent.
 *
 * WITHDRAWN, NEVER DELETED. The office can take a document off the customer's
 * screen; the row and the bytes stay, because an audit of what was attached
 * when a decision was taken has to be able to resolve it.
 */

const CAPTION_LIMIT = 300;

/** The office's capability over the register, or a refusal in its own words. */
const requireOffice = (context: OperationContext, what: string): void => {
  if (can(context.actor.role, 'customers.manage')) return;
  throw new WorkflowError(what, [
    {
      code: 'not_permitted',
      message:
        'A customer’s documents are the office’s register. Your role may read the customer, ' +
        'not their filed paperwork.',
    },
  ]);
};

export const listCustomerDocuments = async (
  context: OperationContext,
  customerId: CustomerId,
  options: { readonly includeArchived?: boolean } = {},
): Promise<readonly CustomerDocument[]> => {
  requireOffice(context, 'Those documents are not available to your role.');
  return context.repos.customers.listDocuments(customerId, options);
};

export const attachCustomerDocument = async (
  context: OperationContext,
  customerId: CustomerId,
  input: UploadedFile & { readonly caption: string },
): Promise<CustomerDocument> => {
  requireOffice(context, 'You cannot attach a document to a customer.');

  const customer = await context.repos.customers.findById(customerId);
  if (customer === null) {
    /*
     * 404-SHAPED REFUSAL, decided here rather than in the route: a customer
     * this actor could not otherwise enumerate must not be confirmed to exist
     * by an upload attempt.
     */
    throw new WorkflowError('That customer does not exist.', [
      { code: 'unknown_customer', message: 'No customer with that id is on the register.' },
    ]);
  }

  const caption = input.caption.trim();
  if (caption.length > CAPTION_LIMIT) {
    throw new WorkflowError('That description is too long.', [
      {
        code: 'caption_too_long',
        message: `Keep it under ${CAPTION_LIMIT} characters; the file name carries the rest.`,
      },
    ]);
  }

  /*
   * ARCHIVED CUSTOMERS TAKE NO NEW PAPERWORK. Reading theirs stays possible —
   * that is the point of archiving rather than deleting — but attaching a new
   * document to a customer EJE have withdrawn is almost always the wrong
   * customer on screen.
   */
  if (!customer.active) {
    throw new WorkflowError(`${customer.name} has been withdrawn from the register.`, [
      {
        code: 'customer_archived',
        message:
          'Restore the customer first if this document belongs to them; their existing documents ' +
          'are still readable.',
      },
    ]);
  }

  /*
   * THE BYTES, OR NOTHING, AND THEN READ BACK — so the row describes a file
   * that can be produced rather than one that was handed to a write call. The
   * store measures the length and the hash on the way out (BACKUP-1), which is
   * what lets the record say later whether the file is still the file.
   *
   * This was three copies of the same twenty lines, one per document path, and
   * the copies had drifted: see `storeAndMeasure`, which exists because the
   * drift is what let two paths record no checksum at all.
   */
  const stored = await storeAndMeasure(
    context,
    { fileName: input.fileName, contentType: input.contentType, bytes: input.bytes },
    { message: 'That document could not be stored.', code: 'document_not_stored' },
  );

  const document: CustomerDocument = {
    id: context.services.ids.next('customer-document'),
    customerId,
    fileName: input.fileName,
    caption,
    contentType: input.contentType,
    storageKey: stored.storageKey,
    sizeBytes: stored.sizeBytes,
    checksumSha256: stored.checksumSha256,
    uploadedAt: context.services.clock.now(),
    uploadedBy: context.actor.id,
    // A file somebody really uploaded. Only the seed writes `simulated`, and
    // it seeds none of these (see `createDemoDatabase`).
    provenance: 'genuine',
    archivedAt: null,
  };

  const saved = await context.repos.customers.saveDocument(document);

  await audit(context, {
    jobId: null,
    type: 'customer_updated',
    summary: `Document attached to ${customer.name}`,
    detail:
      `${saved.fileName}${caption.length === 0 ? '' : ` — ${caption}`} ` +
      `(${saved.sizeBytes} bytes, ${saved.contentType}).`,
  });

  return saved;
};

/**
 * The file itself, authorised by the CUSTOMER and then by the document.
 *
 * Returns null for every refusal that must not be distinguishable from
 * outside: a document id that does not exist, one belonging to another
 * customer, and one whose bytes are gone. The route answers the same 404 to
 * all three, so the endpoint cannot be used to ask which ids are real.
 */
export const readCustomerDocument = async (
  context: OperationContext,
  customerId: CustomerId,
  documentId: string,
): Promise<{ readonly document: CustomerDocument; readonly file: StoredDocument } | null> => {
  requireOffice(context, 'That document is not available to your role.');

  const document = await context.repos.customers.findDocumentById(documentId);
  if (document === null || document.customerId !== customerId) return null;

  /*
   * A DAMAGED FILE IS NOT A MISSING ONE, and it must not be served.
   *
   * The store raises when the bytes no longer match what was recorded with
   * them; that is an incident with its own remedy (restore it), and handing
   * out the bytes anyway is what the checksum exists to prevent.
   */
  let file: StoredDocument | null;
  try {
    file = await context.services.storage.getDocument(document.storageKey);
  } catch (cause) {
    if (!(cause instanceof StorageIntegrityFailed)) throw cause;
    throw new WorkflowError(`${document.fileName} is damaged.`, [
      {
        code: 'document_damaged',
        message:
          'The stored file is not the file that was uploaded, so it has not been served. It must ' +
          'be restored from a backup.',
      },
    ]);
  }

  if (file === null) return null;
  return { document, file };
};

/**
 * Withdraws a document from the customer's screen, keeping the record.
 *
 * The same shape the register uses for a site or a contact: archived, not
 * deleted, because a document that was attached when a decision was taken has
 * to stay resolvable afterwards.
 */
export const withdrawCustomerDocument = async (
  context: OperationContext,
  customerId: CustomerId,
  documentId: string,
): Promise<CustomerDocument> => {
  requireOffice(context, 'You cannot withdraw a customer’s document.');

  const document = await context.repos.customers.findDocumentById(documentId);
  if (document === null || document.customerId !== customerId) {
    throw new WorkflowError('That document does not exist.', [
      { code: 'unknown_document', message: 'No such document is attached to this customer.' },
    ]);
  }
  if (document.archivedAt !== null) return document;

  const withdrawn = await context.repos.customers.saveDocument({
    ...document,
    archivedAt: context.services.clock.now(),
  });

  await audit(context, {
    jobId: null,
    type: 'customer_updated',
    summary: 'Document withdrawn from a customer',
    detail: `${document.fileName} is no longer shown. The file itself is kept.`,
  });

  return withdrawn;
};
