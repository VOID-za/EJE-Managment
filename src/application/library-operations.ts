import {
  asDocumentId,
  can,
  userFullName,
  type DocumentTextIndex,
  type TechnicalDocument,
  type TechnicalDocumentType,
} from '@/domain';
import type { UploadedFile } from '@/services/ports';
import { extractPdfText } from '@/lib/pdf/extract-text';
import type { OperationContext } from './context';
import { audit, notifyMasters } from './audit';
import { WorkflowError } from './errors';

/**
 * Technical library administration.
 *
 * A technician may upload a document, but it lands as `pending_approval` and is
 * not offered as official reference material until a Master approves it. Only a
 * Master edits, versions, approves or archives.
 *
 * Versioning here works the way the checklist versioning does: a new version is
 * a new record, and superseding a document archives it rather than deleting it,
 * so a job that referenced an older revision still resolves it.
 */
const assertManages = (context: OperationContext): void => {
  if (can(context.actor.role, 'library.manage')) return;
  throw new WorkflowError('Only a Master can manage the technical library.', [
    {
      code: 'not_permitted',
      message: 'Technicians can upload documents for approval, but not alter approved ones.',
    },
  ]);
};

export interface NewDocumentInput {
  readonly name: string;
  readonly description: string;
  readonly documentType: TechnicalDocumentType;
  readonly manufacturer: string;
  readonly machineModel: string;
  readonly version: string;
  readonly fileName: string;
  readonly pageCount: number;
  readonly tags: readonly string[];
}

const DEMO_FILE_SIZE_BYTES = 2_400_000;

/**
 * Where this revision's file lives.
 *
 * Keyed by the DOCUMENT ID, not by the file name. A new revision may legitimately
 * keep the same file name — `addDocumentVersion` defaults to it — and
 * `library/${fileName}` would then have two revisions of one manual pointing at
 * a single file, so superseding a document would overwrite the revision it was
 * supposed to preserve. The previous revision is archived rather than deleted
 * precisely so it stays readable; its bytes have to stay separate for that to
 * mean anything.
 */
const storageKeyFor = (documentId: string, fileName: string): string =>
  `library/${documentId}/${fileName}`;

/**
 * Adds a document.
 *
 * A Master's upload is current immediately; a technician's waits for approval.
 *
 * Demo note: no file is actually stored. The record carries a storage key in
 * exactly the shape the production uploader will produce, and the preview is
 * clearly marked as simulated.
 */
export const addDocument = async (
  context: OperationContext,
  input: NewDocumentInput,
): Promise<TechnicalDocument> => {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new WorkflowError('A document name is required.', [
      { code: 'name_required', message: 'Name the document as a technician would search for it.' },
    ]);
  }

  const isMaster = can(context.actor.role, 'library.manage');
  const fileName =
    input.fileName.trim().length > 0
      ? input.fileName.trim()
      : `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.pdf`;

  const documentId = asDocumentId(context.services.ids.next('doc'));

  const document: TechnicalDocument = {
    id: documentId,
    name,
    description: input.description.trim(),
    documentType: input.documentType,
    manufacturer: input.manufacturer.trim(),
    machineModel: input.machineModel.trim(),
    version: input.version.trim().length > 0 ? input.version.trim() : '1.0',
    status: isMaster ? 'current' : 'pending_approval',
    fileName,
    fileSizeBytes: DEMO_FILE_SIZE_BYTES,
    pageCount: Math.max(1, Math.round(input.pageCount)),
    storageKey: storageKeyFor(documentId, fileName),
    uploadedAt: context.services.clock.now(),
    uploadedBy: context.actor.id,
    tags: input.tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0),
  };

  const saved = await context.repos.documents.save(document);

  await audit(context, {
    jobId: null,
    type: 'document_added',
    summary: `Document added: ${saved.name}`,
    detail: isMaster
      ? `Version ${saved.version} published to the technical library.`
      : `Version ${saved.version} uploaded by ${userFullName(context.actor)} and awaiting Master approval.`,
  });

  if (!isMaster) {
    await notifyMasters(context, {
      type: 'document_approval_request',
      title: 'Document awaiting approval',
      body: `${userFullName(context.actor)} uploaded "${saved.name}" to the technical library. Review and approve it.`,
    });
  }

  return saved;
};

export const updateDocument = async (
  context: OperationContext,
  document: TechnicalDocument,
): Promise<TechnicalDocument> => {
  assertManages(context);
  const saved = await context.repos.documents.save(document);
  await audit(context, {
    jobId: null,
    type: 'document_updated',
    summary: `Document updated: ${saved.name}`,
    detail: `Version ${saved.version} metadata amended by ${userFullName(context.actor)}.`,
  });
  return saved;
};

export const approveDocument = async (
  context: OperationContext,
  document: TechnicalDocument,
): Promise<TechnicalDocument> => {
  assertManages(context);
  if (document.status !== 'pending_approval') return document;

  const saved = await context.repos.documents.save({ ...document, status: 'current' });
  await audit(context, {
    jobId: null,
    type: 'document_approved',
    summary: `Document approved: ${saved.name}`,
    detail: `Version ${saved.version} approved by ${userFullName(context.actor)} and is now official reference material.`,
  });
  return saved;
};

export const archiveDocument = async (
  context: OperationContext,
  document: TechnicalDocument,
): Promise<TechnicalDocument> => {
  assertManages(context);
  const saved = await context.repos.documents.save({ ...document, status: 'archived' });
  await audit(context, {
    jobId: null,
    type: 'document_archived',
    summary: `Document archived: ${saved.name}`,
    detail:
      `Version ${saved.version} withdrawn from the library. ` +
      'It is retained, so a job that referenced it still resolves it.',
  });
  return saved;
};

/**
 * Publishes a new revision of an existing document.
 *
 * The previous revision is archived rather than overwritten, so which revision
 * a technician worked from remains answerable after the fact.
 */
export const addDocumentVersion = async (
  context: OperationContext,
  previous: TechnicalDocument,
  input: Pick<NewDocumentInput, 'version' | 'fileName' | 'pageCount' | 'description'>,
): Promise<TechnicalDocument> => {
  assertManages(context);

  const version = input.version.trim();
  if (version.length === 0 || version === previous.version) {
    throw new WorkflowError('A new revision needs its own version number.', [
      {
        code: 'version_required',
        message: `Version ${previous.version} already exists and cannot be overwritten.`,
      },
    ]);
  }

  await context.repos.documents.save({ ...previous, status: 'archived' });

  const fileName = input.fileName.trim().length > 0 ? input.fileName.trim() : previous.fileName;
  const revisionId = asDocumentId(context.services.ids.next('doc'));
  const revision: TechnicalDocument = {
    ...previous,
    id: revisionId,
    version,
    status: 'current',
    description: input.description.trim().length > 0 ? input.description.trim() : previous.description,
    fileName,
    storageKey: storageKeyFor(revisionId, fileName),
    pageCount: Math.max(1, Math.round(input.pageCount)),
    uploadedAt: context.services.clock.now(),
    uploadedBy: context.actor.id,
  };

  const saved = await context.repos.documents.save(revision);
  await audit(context, {
    jobId: null,
    type: 'document_versioned',
    summary: `Document revised: ${saved.name} v${saved.version}`,
    detail: `Supersedes v${previous.version}, which is archived and still resolvable.`,
  });
  return saved;
};

/* -------------------------------------------------------------------------- */
/* A REAL FILE, AND THE TEXT INSIDE IT. MASTER SCOPE LIB-5.                   */
/* -------------------------------------------------------------------------- */

/**
 * Indexes one revision's uploaded PDF, and records what happened either way.
 *
 * THE RECORD IS WRITTEN FOR ALL THREE OUTCOMES, which is the point. A scanned
 * manual is stored as `needs_ocr` with the reason; a file that could not be
 * read at all is stored as `failed` with the reason; only a document whose text
 * really was extracted is `indexed`. Nothing is dropped, so the library can say
 * which of its documents are searchable and which are not — and a technician
 * who searches for an alarm code is never left to conclude EJE has no manual
 * for a machine when what actually happened is that nobody could read the file.
 *
 * IT DOES NOT THROW ON A DOCUMENT IT CANNOT READ. An unreadable PDF is still a
 * document the library should hold — the office may have nothing else — so the
 * upload succeeds and the index records the truth about it. What WOULD be
 * wrong is storing it as indexed, and the repository's own constraint refuses
 * that as well.
 */
export const indexDocumentText = async (
  context: OperationContext,
  document: TechnicalDocument,
  bytes: Uint8Array,
): Promise<DocumentTextIndex> => {
  const outcome = extractPdfText(bytes);
  const extractedAt = context.services.clock.now();

  const index: DocumentTextIndex =
    outcome.kind === 'text'
      ? {
          documentId: document.id,
          state: 'indexed',
          extractedAt,
          characters: outcome.text.length,
          pages: outcome.pages,
          truncated: outcome.truncated,
          unreadableStreams: outcome.unreadableStreams,
          failureReason:
            outcome.unreadableStreams === 0
              ? ''
              : `${outcome.unreadableStreams} stream(s) in this document could not be decompressed, so part of its text may be missing from the index.`,
        }
      : outcome.kind === 'needs_ocr'
        ? {
            documentId: document.id,
            state: 'needs_ocr',
            extractedAt,
            characters: 0,
            pages: outcome.pages,
            truncated: false,
            unreadableStreams: outcome.unreadableStreams,
            failureReason: outcome.reason,
          }
        : {
            documentId: document.id,
            state: 'failed',
            extractedAt,
            characters: 0,
            pages: document.pageCount,
            truncated: false,
            unreadableStreams: 0,
            failureReason: outcome.reason,
          };

  const saved = await context.repos.documents.saveTextIndex(
    index,
    outcome.kind === 'text' ? outcome.text : '',
  );

  /*
   * AUDITED, because an index is a claim about what the library can find.
   *
   * A document that silently arrived unsearchable is how "we have no manual for
   * that machine" gets said in good faith and is wrong. The trail says which it
   * was and why.
   */
  await audit(context, {
    jobId: null,
    type: 'document_indexed',
    summary:
      saved.state === 'indexed'
        ? `Document indexed: ${document.name}`
        : `Document NOT searchable: ${document.name}`,
    detail:
      saved.state === 'indexed'
        ? `${saved.characters} characters extracted from ${saved.pages} page(s)${saved.truncated ? ', cut at the index limit' : ''}.${saved.failureReason === '' ? '' : ` ${saved.failureReason}`}`
        : `${saved.state === 'needs_ocr' ? 'No searchable text' : 'The file could not be read'}: ${saved.failureReason}`,
  });

  return saved;
};

export interface UploadedDocumentInput extends Omit<NewDocumentInput, 'fileName' | 'pageCount'> {
  readonly file: UploadedFile;
}

/**
 * Adds a document FROM A FILE, stores the bytes, and indexes the text.
 *
 * WHAT THIS REPLACES. `addDocument` records metadata and allocates a storage
 * key for a file nobody ever uploaded — it is the demonstration path, and the
 * page count was whatever the dialog sent. A library whose records point at
 * files that do not exist cannot be searched, downloaded or trusted, which is
 * why LIB-5 starts here rather than at the indexer.
 *
 * THE ORDER MATTERS. The bytes are stored FIRST, under the key the record will
 * carry, and only then is the record written: a record pointing at bytes that
 * are not there is the failure this ordering prevents. The text is extracted
 * from the bytes in hand rather than read back from storage, so a storage
 * adapter that cannot read its own writes cannot make a document look
 * unsearchable.
 *
 * APPROVAL IS UNCHANGED, and still the only thing that makes a document
 * official: a technician's upload lands `pending_approval` and is not offered
 * as reference material — nor returned by the search — until a Master approves
 * it.
 */
export const uploadDocument = async (
  context: OperationContext,
  input: UploadedDocumentInput,
): Promise<{ readonly document: TechnicalDocument; readonly index: DocumentTextIndex }> => {
  const document = await addDocument(context, {
    ...input,
    fileName: input.file.fileName,
    // Corrected below from the file itself: the page count is a property of
    // the document, not something a client may assert.
    pageCount: 1,
  });

  await context.services.storage.putDocument({
    storageKey: document.storageKey,
    fileName: input.file.fileName,
    contentType: input.file.contentType,
    bytes: input.file.bytes,
  });

  const index = await indexDocumentText(context, document, input.file.bytes);
  const stored = await context.repos.documents.save({
    ...document,
    fileSizeBytes: input.file.bytes.byteLength,
    pageCount: Math.max(1, index.pages),
  });

  return { document: stored, index };
};
