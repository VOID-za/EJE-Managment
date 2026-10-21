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

/**
 * WHERE THE INDEXED TEXT CAME FROM. LIB-5.
 *
 * NOT A DETAIL, and the reason it is on the record rather than inferred: text
 * lifted out of a PDF's own text layer is what the document says. Text produced
 * by RECOGNISING PIXELS is a machine's reading of what the document looks like,
 * and on a scanned electrical diagram it will contain mistakes — a `B` for an
 * `8`, a missing minus sign in a tolerance. A technician searching for an alarm
 * code needs to know which of those they are reading, because one is evidence
 * and the other is a hint.
 *
 * So a search result from OCR text is labelled as such, and this is what makes
 * that possible. `null` while nothing has been indexed.
 */
export type DocumentTextSource = 'text_layer' | 'ocr';

export interface DocumentTextIndex {
  /** The REVISION this text came out of. A new revision indexes itself. */
  readonly documentId: DocumentId;
  readonly state: DocumentIndexState;
  /**
   * How the text was obtained. Set only when the state is `indexed`.
   *
   * Every row written before this existed is `text_layer`, which is true of
   * all of them: there was no other way to get text until OCR existed.
   */
  readonly source: DocumentTextSource | null;
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
 * WORK WAITING FOR TEXT RECOGNITION. LIB-5.
 *
 * WHY THERE IS A QUEUE AT ALL. Lifting text out of a PDF's text layer takes
 * milliseconds and happens while the upload request is open, which is right.
 * RECOGNISING a scanned page takes 5 to 15 seconds per page, and a 214-page
 * Leadwell manual is therefore somewhere between twenty minutes and an hour —
 * inside an HTTP request that will have timed out long before, holding a
 * transaction open, with the office watching a spinner. So the upload records
 * that the document needs recognition and RETURNS, and the work is done
 * afterwards by something that may take as long as it takes.
 *
 * WHAT EACH STATE MEANS, and none of them means "searchable" — that is
 * `DocumentTextIndex.state`, and it is the only thing that answers it:
 *
 *  - `queued`      — recognised text is wanted and no attempt is running.
 *  - `running`     — a worker has claimed it. Carries `startedAt` so a worker
 *                    that died can be told from one that is still going.
 *  - `done`        — recognition produced text and the index was updated. The
 *                    row is kept, because "this document's text came from OCR
 *                    on this date, in this many seconds" is worth having.
 *  - `failed`      — recognition ran and could not produce usable text. Kept
 *                    with the reason and the attempt count; a failure that is
 *                    dropped is a document nobody finds out is unsearchable.
 *  - `unavailable` — no recognition engine is installed on this server. NOT a
 *                    failure of the document, and said differently on screen,
 *                    because the remedy is an installation rather than a
 *                    better scan.
 */
export type OcrJobState = 'queued' | 'running' | 'done' | 'failed' | 'unavailable';

export const OCR_JOB_STATES: readonly OcrJobState[] = [
  'queued',
  'running',
  'done',
  'failed',
  'unavailable',
];

export interface OcrJob {
  /** The REVISION whose pixels are to be read. One job per revision. */
  readonly documentId: DocumentId;
  readonly state: OcrJobState;
  /**
   * How many times recognition has been ATTEMPTED, including the one running.
   *
   * It is what stops a document that fails every time from being retried for
   * ever, and what lets an operator see the difference between "nobody has
   * tried" and "this has been tried four times".
   */
  readonly attempts: number;
  readonly queuedAt: IsoDateTime;
  readonly startedAt: IsoDateTime | null;
  readonly finishedAt: IsoDateTime | null;
  /** Empty unless the state is `failed` or `unavailable`. Never a stack trace. */
  readonly lastError: string;
  /** Which engine produced the outcome, as the engine named itself. */
  readonly engine: string;
}

/**
 * The most times recognition is attempted before it is left alone.
 *
 * Three, and then it stays `failed` until somebody asks again. A page that
 * cannot be read will not become readable by being read a fourth time, and a
 * queue that retries for ever is a queue that hides a permanent failure behind
 * a permanently non-empty list.
 */
export const OCR_MAX_ATTEMPTS = 3;

/**
 * How long a claimed job may be `running` before another worker may take it.
 *
 * A worker that is killed mid-page leaves a `running` row that nothing will
 * ever finish, and without an expiry that document is stuck for good. Twenty
 * minutes is longer than the worst page this will meet and shorter than a
 * working day.
 */
export const OCR_STALE_AFTER_MS = 20 * 60 * 1000;

/** True when a `running` job has been claimed for longer than it should be. */
export const isOcrJobStale = (job: OcrJob, now: IsoDateTime): boolean => {
  if (job.state !== 'running' || job.startedAt === null) return false;
  const started = Date.parse(job.startedAt);
  const current = Date.parse(now);
  if (!Number.isFinite(started) || !Number.isFinite(current)) return false;
  return current - started >= OCR_STALE_AFTER_MS;
};

/**
 * True when this job may be attempted now.
 *
 * THREE STATES ARE CLAIMABLE AND TWO ARE NOT, and the division is the whole
 * retry policy:
 *
 *  - `queued`  — obviously.
 *  - `running` and STALE — a worker killed mid-page must not strand its
 *    document for good.
 *  - `failed`, while under the attempt cap. A failure can be the document
 *    (a blank scan, which will fail again) or the machine (a full disk, the
 *    engine killed on one page, a transient read), and nothing here can tell
 *    them apart. Trying again twice more costs minutes and fixes the second
 *    kind; not trying leaves a document unsearchable because of something that
 *    had already gone away. This is what the attempt cap is FOR — without it
 *    the cap would only ever bite on stale reclaims, which are rare.
 *
 *  - `unavailable` is NOT retried, because nothing has changed: no engine is
 *    installed and the next attempt would say the same thing. It waits for
 *    `requeueOcr`, which is somebody saying they have installed one.
 *  - `done` is finished.
 */
export const isOcrJobClaimable = (job: OcrJob, now: IsoDateTime): boolean => {
  if (job.attempts >= OCR_MAX_ATTEMPTS) return false;
  if (job.state === 'queued' || job.state === 'failed') return true;
  return isOcrJobStale(job, now);
};

/**
 * What each state is called on screen. One map, in the domain.
 *
 * Deliberately NOT a paraphrase of the state name: each one says what it means
 * for the person reading it, and none of them implies the document is
 * searchable.
 */
export const OCR_JOB_STATE_LABEL: Record<OcrJobState, string> = {
  queued: 'Waiting for text recognition',
  running: 'Reading the pages now',
  done: 'Text recognised',
  failed: 'Text recognition could not read it',
  unavailable: 'No text recognition on this server',
};

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
