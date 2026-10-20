import type { DocumentId, IsoDateTime, UserId } from './common';
import type { Provenance } from './provenance';

/**
 * The library's categories. October mandate §3.
 *
 * The last five were asked for by name and had nowhere to go: a checklist, a
 * training document, an internal company procedure, a form and a certificate
 * were all being filed as `work_procedure`, which made them unfindable as what
 * they are. Added, never renamed, so every existing document keeps its
 * category.
 */
export type TechnicalDocumentType =
  | 'machine_manual'
  | 'electrical_diagram'
  | 'service_manual'
  | 'safety_procedure'
  | 'work_procedure'
  | 'datasheet'
  | 'checklist'
  | 'training'
  | 'internal_procedure'
  | 'form'
  | 'certificate';

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
  /**
   * The length of the stored file, as the store MEASURED it. Zero means there
   * is no file — see `provenance` for whether that is expected.
   *
   * It used to be whatever the seed said: nine documents claimed sizes from
   * 980 kB to 18.4 MB and not one of them had a byte behind it, so the library
   * displayed "18.4 MB, 214 pages" for a manual nobody could open. A size is
   * now measured or absent.
   */
  readonly fileSizeBytes: number;
  /** Pages in the stored file. Zero when there is no file to count. */
  readonly pageCount: number;
  readonly storageKey: string;
  /**
   * Whether this is an EJE document or demonstration data. Section 1 of the
   * October mandate: a demonstration document must never be mistakable for a
   * real one, and the answer is recorded on the row rather than guessed from
   * its name.
   */
  readonly provenance: Provenance;
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

/**
 * What each category is called on screen. One map, in the domain.
 *
 * It lived in `library/page.tsx`, so the five categories added for the October
 * mandate would have been unlabelled anywhere else that lists a type — and the
 * upload dialog, the search results and the job screens all do.
 */
export const TECHNICAL_DOCUMENT_TYPE_LABEL: Record<TechnicalDocumentType, string> = {
  machine_manual: 'Machine Manual',
  electrical_diagram: 'Electrical Diagram',
  service_manual: 'Service Manual',
  safety_procedure: 'Safety Procedure',
  work_procedure: 'Service Procedure',
  datasheet: 'Datasheet',
  checklist: 'Checklist',
  training: 'Training Document',
  internal_procedure: 'Internal Company Procedure',
  form: 'Form',
  certificate: 'Certificate',
};
