import { StorageIntegrityFailed, type StoredDocument } from '@/services/ports';
import type { OperationContext } from './context';
import { WorkflowError } from './errors';

/**
 * STORE THE BYTES, READ THEM BACK, AND MEASURE WHAT CAME BACK.
 *
 * WHY THIS IS ONE FUNCTION AND NOT FIVE COPIES. Six paths put a file somewhere
 * — a job photograph, a job video, a job document, checklist evidence, a
 * machine photograph, a machine document, a customer document — and each wrote
 * its own version of the same four steps. They had drifted, which is how the
 * defect below survived:
 *
 *   - `customerDocument` and `attachDocument` stored, READ BACK, and recorded
 *     the length and SHA-256 the store measured on the way out;
 *   - `addMedia` and `addChecklistPhoto` stored and recorded
 *     `input.bytes.length`, and NO CHECKSUM AT ALL — `job_media` has had a
 *     `checksum_sha256` column the whole time and nothing ever wrote to it.
 *
 * SO A DAMAGED JOB PHOTOGRAPH COULD NOT BE TOLD FROM A SOUND ONE. The store
 * recomputes the hash on every read and refuses bytes that are not the bytes
 * that were written — but with no hash on the row, nothing could say whether a
 * file that reads back cleanly is the file the technician took. The evidence a
 * customer signs for had the weakest integrity record of anything in the
 * system, and the customer's own paperwork had the strongest.
 *
 * WHAT IT GUARANTEES to every caller:
 *
 *   1. the bytes are in storage, or this raised — `storeUpload` has no third
 *      answer;
 *   2. they have been READ BACK, so the row describes a file that can actually
 *      be produced rather than one that was handed to a write call;
 *   3. `sizeBytes` and `checksumSha256` are the store's own measurements of
 *      what came back, not the caller's measurements of what went in. On a
 *      write that silently truncated, those two differ, and this is the only
 *      place the difference can be noticed.
 *
 * THE ORDER IS THE CONSISTENCY STORY and it is deliberately this way round:
 * bytes first, row second. A row pointing at a file that was never written
 * tells somebody a document exists when it does not, which is the failure that
 * matters. The other direction — bytes with no row — is cleaned up by the
 * transaction's own rollback; see `trackStorageWrites`.
 */
export interface MeasuredFile {
  readonly storageKey: string;
  /** Measured off the bytes the store produced, never off what was sent. */
  readonly sizeBytes: number;
  readonly checksumSha256: string | null;
}

export const storeAndMeasure = async (
  context: OperationContext,
  file: { readonly fileName: string; readonly contentType: string; readonly bytes: Uint8Array },
  refusal = 'That file could not be stored.',
): Promise<MeasuredFile> => {
  const stored = await context.services.storage.storeUpload({
    fileName: file.fileName,
    contentType: file.contentType,
    bytes: file.bytes,
  });

  /*
   * READ BACK, and a refusal from the store is treated as "nothing usable
   * landed" rather than propagated. `StorageIntegrityFailed` means the bytes
   * are there and are not the bytes that were written — on a file written one
   * line ago that is a failing disk, and the honest answer to the caller is
   * that the upload did not work, not a stack trace about checksums.
   */
  let readBack: StoredDocument | null;
  try {
    readBack = await context.services.storage.getDocument(stored.storageKey);
  } catch (cause) {
    if (!(cause instanceof StorageIntegrityFailed)) throw cause;
    readBack = null;
  }

  if (readBack === null || readBack.bytes.byteLength === 0) {
    throw new WorkflowError(refusal, [
      {
        code: 'file_not_stored',
        message: 'The file did not land in storage, so nothing was recorded. Try again.',
      },
    ]);
  }

  return {
    storageKey: stored.storageKey,
    sizeBytes: readBack.sizeBytes ?? readBack.bytes.byteLength,
    checksumSha256: readBack.sha256 ?? null,
  };
};

/**
 * Reads back and measures bytes written at an EXPLICIT key.
 *
 * WHY THERE ARE TWO OF THESE. `storeAndMeasure` both writes and measures, and
 * it chooses the key — which is right for every path where the key is the
 * store's business. The library is the exception: a revision's key is generated
 * when the RECORD is created, because the record is what carries it, so the
 * bytes go through `putDocument` at a key that already exists on a row.
 *
 * THE LIBRARY WAS THE LAST PATH THAT MEASURED NOTHING. It wrote the bytes and
 * then recorded `input.file.bytes.byteLength` — the length of what was handed
 * to the write — and `library_document_versions.checksum_sha256` has existed
 * the whole time with nothing writing to it. Exactly the gap `job_media` had:
 * a manual a technician works from on site could not be told from a damaged
 * copy of itself.
 */
export const measureStored = async (
  context: OperationContext,
  storageKey: string,
  refusal = 'That file could not be stored.',
): Promise<MeasuredFile> => {
  let readBack: StoredDocument | null;
  try {
    readBack = await context.services.storage.getDocument(storageKey);
  } catch (cause) {
    if (!(cause instanceof StorageIntegrityFailed)) throw cause;
    readBack = null;
  }

  if (readBack === null || readBack.bytes.byteLength === 0) {
    throw new WorkflowError(refusal, [
      {
        code: 'file_not_stored',
        message: 'The file did not land in storage, so nothing was recorded. Try again.',
      },
    ]);
  }

  return {
    storageKey,
    sizeBytes: readBack.sizeBytes ?? readBack.bytes.byteLength,
    checksumSha256: readBack.sha256 ?? null,
  };
};
