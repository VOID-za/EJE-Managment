import type { DocumentId, IsoDateTime, UserId } from './common';

export type TechnicalDocumentType =
  | 'machine_manual'
  | 'electrical_diagram'
  | 'service_manual'
  | 'safety_procedure'
  | 'work_procedure'
  | 'datasheet';

export interface TechnicalDocument {
  readonly id: DocumentId;
  readonly name: string;
  readonly description: string;
  readonly documentType: TechnicalDocumentType;
  readonly manufacturer: string;
  readonly machineModel: string;
  readonly version: string;
  readonly status: 'current' | 'archived' | 'pending_approval';
  readonly fileName: string;
  readonly fileSizeBytes: number;
  readonly pageCount: number;
  readonly storageKey: string;
  readonly uploadedAt: IsoDateTime;
  readonly uploadedBy: UserId;
  readonly tags: readonly string[];
}

/**
 * WHAT IS KNOWN ABOUT A DOCUMENT'S SEARCHABLE TEXT. MASTER SCOPE LIB-5.
 *
 * ITS OWN RECORD, PER REVISION, AND NEVER A BOOLEAN. "Is it indexed?" has four
 * honest answers and only one of them is yes, so the state is named rather
 * than implied:
 *
 *  - `indexed`    — text was extracted and is searchable. `characters` says how
 *                   much, so "indexed" cannot hide an empty index.
 *  - `needs_ocr`  — the file is a PDF and has no readable text in it: a scanned
 *                   manual, or one whose fonts carry no usable encoding. It is
 *                   NOT searchable and the library says so. This is a state a
 *                   document can be brought OUT of — by uploading a text-based
 *                   copy, or by OCR if EJE ever decide to pay for it — which is
 *                   why it is recorded rather than treated as a failure.
 *  - `failed`     — the file could not be read at all: not a PDF, or encrypted.
 *                   `failureReason` carries what went wrong, because an
 *                   extraction failure that is silently dropped is a document
 *                   nobody ever finds out is missing from the index.
 *
 * A revision with NO record at all is simply not indexed yet, which is the
 * state every document added as metadata alone is in.
 *
 * The extracted text itself is not on this record: it is held separately and
 * read back only for the snippets of a result page. See `library-search.ts`.
 */
export type DocumentIndexState = 'indexed' | 'needs_ocr' | 'failed';

export interface DocumentTextIndex {
  /** The REVISION this text came out of. A new revision indexes itself. */
  readonly documentId: DocumentId;
  readonly state: DocumentIndexState;
  readonly extractedAt: IsoDateTime;
  /** Characters indexed. Zero whenever the state is not `indexed`. */
  readonly characters: number;
  readonly pages: number;
  /** True when the document was longer than one index entry may carry. */
  readonly truncated: boolean;
  /** Streams that could not be decompressed, so a partial read says so. */
  readonly unreadableStreams: number;
  readonly failureReason: string;
}
