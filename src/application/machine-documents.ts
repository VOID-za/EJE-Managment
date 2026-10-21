import {
  can,
  isFieldReadable,
  type MachineDocument,
  type MachineDocumentAudience,
  type MachineId,
} from '@/domain';
import type { OperationContext } from './context';
import { WorkflowError } from './errors';
import { audit } from './audit';
import { StorageIntegrityFailed, type StoredDocument, type UploadedFile } from '@/services/ports';
import { storeAndMeasure } from './stored-file';

/**
 * FILES ATTACHED TO A MACHINE. October mandate §4.
 *
 * WHAT WAS MISSING. A machine carried PHOTOGRAPHS and nothing else. The paper
 * that belongs to one machine — its commissioning report, its compliance
 * certificate, the laser-calibration results for that serial number — had
 * nowhere to live: the technical library files by manufacturer and MODEL, so a
 * calibration result filed there would be wrong for every other machine of
 * that model, and `machine_photos` renders inline as a thumbnail, which is
 * what a PDF filed as a photograph looks like when it fails.
 *
 * WHO MAY, AND WHY IT IS NOT THE SAME ANSWER AS A CUSTOMER'S PAPERWORK.
 * Attaching and withdrawing need `machines.manage`, the office's capability
 * over the register. READING depends on the DOCUMENT, not on the role alone:
 *
 *   - the office reads everything, as it does everywhere on the register;
 *   - a technician reads the documents the office marked `field`.
 *
 * That is MEDIA-1's rule, applied to a second kind of paper. It is not a
 * business question answered by implementation: the office decides, per
 * document, and the decision is recorded on the row. A machine manual exists
 * to be read at the machine, and the alternative — office-only, as for a
 * customer's credit application — would mean a technician driving to a machine
 * and telephoning the office to be told what its control system is.
 *
 *   WHAT IS STILL EJE'S TO SETTLE: whether `field` should be the DEFAULT when
 *   the office attaches a document without saying. It is not, and the safe
 *   direction is the one implemented — a document nobody classified is not
 *   shown to the field. Recorded in `docs/outstanding-scope.md`.
 *
 * THE BYTES LAND FIRST, as everywhere else in this system (MEDIA-6,
 * CHK-EVIDENCE-1, CUST-DOC-1): `storeUpload` writes them or raises, and only
 * then is the row written.
 *
 * WITHDRAWN, NEVER DELETED, for the reason the register archives a site: a
 * compliance certificate that was on file when a machine was signed off has to
 * stay resolvable afterwards.
 */

const CAPTION_LIMIT = 300;

const AUDIENCES: readonly MachineDocumentAudience[] = ['field', 'office_only'];

/** Parses what the office said about the audience, defaulting to the safe one. */
export const asMachineDocumentAudience = (value: string | undefined): MachineDocumentAudience =>
  AUDIENCES.includes(value as MachineDocumentAudience)
    ? (value as MachineDocumentAudience)
    : 'office_only';

/** The office's capability over the register, or a refusal in its own words. */
const requireOffice = (context: OperationContext, what: string): void => {
  if (can(context.actor.role, 'machines.manage')) return;
  throw new WorkflowError(what, [
    {
      code: 'not_permitted',
      message:
        'The machine register is the office’s. Your role may read a machine and the documents ' +
        'filed for the field, not change what is on it.',
    },
  ]);
};

/**
 * The documents on a machine, as the ASKER may see them.
 *
 * Filtered here rather than on the screen, so a technician's response does not
 * carry an office-only document at all. A screen that hides a row still
 * received it.
 */
export const listMachineDocuments = async (
  context: OperationContext,
  machineId: MachineId,
  options: { readonly includeArchived?: boolean } = {},
): Promise<readonly MachineDocument[]> => {
  const documents = await context.repos.machines.listDocuments(machineId, options);
  if (can(context.actor.role, 'machines.manage')) return documents;
  return documents.filter(isFieldReadable);
};

export const attachMachineDocument = async (
  context: OperationContext,
  machineId: MachineId,
  input: UploadedFile & {
    readonly caption: string;
    readonly audience: MachineDocumentAudience;
  },
): Promise<MachineDocument> => {
  requireOffice(context, 'You cannot attach a document to a machine.');

  const machine = await context.repos.machines.findById(machineId);
  if (machine === null) {
    throw new WorkflowError('That machine does not exist.', [
      { code: 'unknown_machine', message: 'No machine with that id is on the register.' },
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
   * AN ARCHIVED MACHINE TAKES NO NEW PAPERWORK, and reading its existing
   * documents stays possible — that is what archiving rather than deleting is
   * for. Attaching to a machine EJE have withdrawn is almost always the wrong
   * machine on screen; two machines of the same model at the same customer is
   * exactly how that happens.
   */
  if (machine.archivedAt !== null) {
    throw new WorkflowError('That machine has been withdrawn from the register.', [
      {
        code: 'machine_archived',
        message:
          'Restore the machine first if this document belongs to it; its existing documents are ' +
          'still readable.',
      },
    ]);
  }

  // The bytes, or nothing — then read back and measured. One helper for every
  // path that stores a file; see `storeAndMeasure`.
  const stored = await storeAndMeasure(
    context,
    { fileName: input.fileName, contentType: input.contentType, bytes: input.bytes },
    { message: 'That document could not be stored.', code: 'document_not_stored' },
  );

  const document: MachineDocument = {
    id: context.services.ids.next('machine-document'),
    machineId,
    fileName: input.fileName,
    caption,
    contentType: input.contentType,
    storageKey: stored.storageKey,
    sizeBytes: stored.sizeBytes,
    checksumSha256: stored.checksumSha256,
    audience: input.audience,
    uploadedAt: context.services.clock.now(),
    uploadedBy: context.actor.id,
    // A file somebody really uploaded. The seed writes none of these.
    provenance: 'genuine',
    archivedAt: null,
  };

  const saved = await context.repos.machines.saveDocument(document);

  await audit(context, {
    jobId: null,
    type: 'machine_updated',
    summary: `Document attached to ${machine.manufacturer} ${machine.model}`,
    detail:
      `${saved.fileName}${caption.length === 0 ? '' : ` — ${caption}`} ` +
      `(${saved.sizeBytes} bytes, ${saved.contentType}), ` +
      `${saved.audience === 'field' ? 'readable in the field' : 'office only'}.`,
  });

  return saved;
};

/**
 * The file itself, authorised by the MACHINE, then by the document's audience.
 *
 * Returns null for every refusal that must not be distinguishable from
 * outside: a document id that does not exist, one belonging to another
 * machine, one a technician may not read, and one whose bytes are gone. The
 * route answers the same 404 to all four, so the endpoint cannot be used to
 * ask which ids are real OR which documents the office kept to itself.
 */
export const readMachineDocument = async (
  context: OperationContext,
  machineId: MachineId,
  documentId: string,
): Promise<{ readonly document: MachineDocument; readonly file: StoredDocument } | null> => {
  const document = await context.repos.machines.findDocumentById(documentId);
  if (document === null || document.machineId !== machineId) return null;

  /*
   * THE AUDIENCE IS A 404, NOT A 403. A refusal that said "you may not read
   * this one" would tell a technician which machines carry paperwork the
   * office is keeping from them, which is a thing they can act on and nothing
   * they are owed.
   */
  if (!can(context.actor.role, 'machines.manage') && !isFieldReadable(document)) return null;

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

/** Takes a document off the machine's screen, keeping the row and the bytes. */
export const withdrawMachineDocument = async (
  context: OperationContext,
  machineId: MachineId,
  documentId: string,
): Promise<MachineDocument> => {
  requireOffice(context, 'You cannot withdraw a machine’s document.');

  const document = await context.repos.machines.findDocumentById(documentId);
  if (document === null || document.machineId !== machineId) {
    throw new WorkflowError('That document does not exist.', [
      { code: 'unknown_document', message: 'No such document is attached to this machine.' },
    ]);
  }
  if (document.archivedAt !== null) return document;

  const withdrawn = await context.repos.machines.saveDocument({
    ...document,
    archivedAt: context.services.clock.now(),
  });

  await audit(context, {
    jobId: null,
    type: 'machine_updated',
    summary: 'Document withdrawn from a machine',
    detail: `${document.fileName} is no longer shown. The file itself is kept.`,
  });

  return withdrawn;
};
