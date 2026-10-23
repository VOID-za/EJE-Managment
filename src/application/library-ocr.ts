import {
  OCR_MAX_ATTEMPTS,
  type DocumentId,
  type DocumentTextIndex,
  type OcrJob,
  type TechnicalDocument,
} from '@/domain';
import type { OcrService } from '@/services/ocr';
import { StorageIntegrityFailed } from '@/services/ports';
import type { OperationContext } from './context';
import { audit } from './audit';

/**
 * RECOGNISING THE TEXT IN A SCANNED LIBRARY DOCUMENT. MASTER SCOPE LIB-5.
 *
 * WHY THIS IS NOT PART OF THE UPLOAD. Lifting a PDF's own text layer takes
 * milliseconds and happens inside the upload request — `indexDocumentText`
 * does it and should. RECOGNISING pixels takes 5 to 15 seconds a page, so the
 * 214-page Leadwell manual `docs/library-ocr.md` costs is twenty minutes to an
 * hour: inside an HTTP request that timed out long ago, holding a transaction
 * open, with the office watching a spinner. So the upload records that the
 * document needs recognition and RETURNS, and this is what happens afterwards.
 *
 * THE RULE THIS FILE EXISTS TO KEEP: nothing is ever reported as searchable
 * unless text was actually extracted and indexed. There are four ways
 * recognition ends and only one of them touches the index.
 *
 *   text        → the index becomes `indexed` with `source: 'ocr'`, and the
 *                 job is `done`.
 *   empty       → the index is LEFT ALONE at `needs_ocr`, and the job is
 *                 `failed` with the reason. The document is still not
 *                 searchable and still says so.
 *   unavailable → the index is LEFT ALONE, and the job is `unavailable`. Not a
 *                 failure of the document: the remedy is an installation.
 *   thrown      → the index is LEFT ALONE and the job is `failed`. An engine
 *                 that throws is a broken engine, and a broken engine must not
 *                 be able to mark a document unsearchable-for-ever or crash a
 *                 worker partway through a queue.
 *
 * `source: 'ocr'` IS NOT DECORATION. Text out of a scan contains mistakes — a
 * `B` for an `8`, a missing minus sign in a tolerance — and a technician
 * searching for an alarm code needs to know whether they are reading the
 * document or a machine's reading of it.
 */

/**
 * Puts a revision in the queue, or leaves an existing entry where it is.
 *
 * IDEMPOTENT, because the upload path calls it every time a document comes out
 * of extraction as `needs_ocr` — including a re-upload of the same revision.
 * An entry that has already run, failed or been abandoned is NOT reset: that
 * would be a retry nobody asked for, and `requeueOcrJob` is what asking looks
 * like.
 */
export const enqueueOcr = async (
  context: OperationContext,
  documentId: DocumentId,
): Promise<OcrJob> => {
  const existing = await context.repos.documents.findOcrJob(documentId);
  if (existing !== null) return existing;

  return context.repos.documents.saveOcrJob({
    documentId,
    state: 'queued',
    attempts: 0,
    queuedAt: context.services.clock.now(),
    startedAt: null,
    finishedAt: null,
    lastError: '',
    engine: '',
  });
};

/**
 * Asks for a job to be tried again, deliberately.
 *
 * THE ONLY WAY A SETTLED JOB GOES BACK IN THE QUEUE, and it resets the attempt
 * count because the person asking knows something changed — an engine was
 * installed, a better scan replaced the file, somebody wants to see the error
 * again. Without a reset, a document that had used its three attempts could
 * never be retried even after the thing that was wrong had been fixed.
 */
export const requeueOcr = async (
  context: OperationContext,
  documentId: DocumentId,
): Promise<OcrJob | null> => {
  const existing = await context.repos.documents.findOcrJob(documentId);
  if (existing === null) return null;

  /*
   * A RUNNING JOB IS LEFT ALONE. Resetting it would let a second worker claim
   * the same document while the first is still reading it, which is the race
   * `claimOcrJob` exists to prevent — undone from the other end.
   */
  if (existing.state === 'running') return existing;

  return context.repos.documents.saveOcrJob({
    ...existing,
    state: 'queued',
    attempts: 0,
    startedAt: null,
    finishedAt: null,
    lastError: '',
  });
};

export interface OcrAttempt {
  readonly job: OcrJob;
  /** Set only when the index was actually changed. */
  readonly index: DocumentTextIndex | null;
}

/**
 * Runs recognition for ONE claimed job and records what happened.
 *
 * The job must already be claimed — `claimOcrJob` is what does that and what
 * makes sure only one worker holds it. This is handed the claimed job so the
 * claim and the work cannot drift apart.
 */
export const runOcrAttempt = async (
  context: OperationContext,
  engine: OcrService,
  job: OcrJob,
): Promise<OcrAttempt> => {
  const settle = (
    state: OcrJob['state'],
    lastError: string,
    engineName: string,
  ): Promise<OcrJob> =>
    context.repos.documents.saveOcrJob({
      ...job,
      state,
      startedAt: null,
      finishedAt: context.services.clock.now(),
      lastError,
      engine: engineName,
    });

  const document = await context.repos.documents.findById(job.documentId);
  if (document === null) {
    /*
     * The revision is gone. The queue row cascades with it on PostgreSQL, so
     * this is the demonstration store or a race — and either way there is
     * nothing to read and nothing to index.
     */
    return {
      job: await settle('failed', 'That revision no longer exists.', job.engine),
      index: null,
    };
  }

  let bytes: Uint8Array | null = null;
  try {
    const stored = await context.services.storage.getDocument(document.storageKey);
    bytes = stored === null ? null : stored.bytes;
  } catch (cause) {
    if (!(cause instanceof StorageIntegrityFailed)) throw cause;
    /*
     * THE BYTES ARE DAMAGED, and that is not something recognition can fix.
     * Reported as a failure of the job with the store's own reason, so the
     * library shows why rather than leaving a document queued for ever.
     */
    return {
      job: await settle(
        'failed',
        'The stored file is damaged and could not be read. Restore it from a backup.',
        job.engine,
      ),
      index: null,
    };
  }

  if (bytes === null || bytes.byteLength === 0) {
    return {
      job: await settle('failed', 'There is no stored file for that revision.', job.engine),
      index: null,
    };
  }

  /*
   * WHICH PAGES STILL NEED READING. LIB-TEXT-1.
   *
   * A manual whose typeset pages came out of the text layer is
   * `partially_indexed`, and the pages that are already in the index are the
   * ones with page rows. Recognition is aimed at the REST — the scanned
   * diagrams — which on a 214-page manual with one of them is 25 seconds of
   * work instead of 83 minutes (BD-21's measurement), and leaves the good text
   * where it is.
   *
   * EMPTY MEANS THE WHOLE DOCUMENT, which is the right answer for a scan and
   * for a deployment whose extractor cannot attribute pages: there is nothing
   * to keep, so there is nothing to aim around.
   */
  const existingIndex = await context.repos.documents.findTextIndex(job.documentId);
  const existingPages = await context.repos.documents.listPageText(job.documentId);
  const alreadyRead = new Set(existingPages.map((page) => page.pageNumber));
  const totalPages = existingIndex?.pages ?? document.pageCount;
  const pagesToRead =
    alreadyRead.size === 0
      ? []
      : Array.from({ length: totalPages }, (_unused, offset) => offset + 1).filter(
          (pageNumber) => !alreadyRead.has(pageNumber),
        );

  /*
   * NOTHING LEFT TO READ IS NOT A FAILURE AND NOT WORK. It happens when a
   * re-extraction with a better engine indexed every page while this job sat
   * in the queue. The job is closed as done and the index is left alone.
   */
  if (alreadyRead.size > 0 && pagesToRead.length === 0) {
    const settled = await settle('done', '', job.engine);
    await audit(context, {
      jobId: null,
      type: 'document_indexed',
      summary: `Text recognition not needed: ${document.name}`,
      detail:
        'Every page of this document was already in the index by the time recognition ran, so ' +
        'nothing was recognised and nothing was changed.',
    });
    return { job: settled, index: existingIndex };
  }

  let outcome;
  try {
    outcome = await engine.read(
      bytes,
      pagesToRead.length === 0 ? undefined : { pages: pagesToRead },
    );
  } catch (cause) {
    /*
     * AN ENGINE THAT THROWS IS A BROKEN ENGINE. The port says it must not, and
     * this is what makes that a contract rather than a hope: a broken engine
     * cannot crash the worker partway through a queue, and it cannot mark a
     * document unsearchable for ever either, because `failed` still leaves the
     * attempts countable and `requeueOcr` can ask again.
     */
    return {
      job: await settle(
        'failed',
        `The recognition engine failed: ${cause instanceof Error ? cause.message : 'unknown error'}.`,
        job.engine,
      ),
      index: null,
    };
  }

  if (outcome.kind === 'unavailable') {
    const settled = await settle('unavailable', outcome.reason, 'none');
    await audit(context, {
      jobId: null,
      type: 'document_indexed',
      summary: `Text recognition unavailable: ${document.name}`,
      detail: outcome.reason,
    });
    return { job: settled, index: null };
  }

  if (outcome.kind === 'empty') {
    const settled = await settle('failed', outcome.reason, outcome.engine);
    await audit(context, {
      jobId: null,
      type: 'document_indexed',
      summary: `Text recognition found nothing: ${document.name}`,
      detail: `${outcome.reason} The document is still NOT searchable and says so.`,
    });
    return { job: settled, index: null };
  }

  /*
   * TEXT, MERGED WITH WHAT WAS ALREADY THERE. LIB-TEXT-1.
   *
   * The ONLY path that touches the index, and it used to REPLACE it — which
   * was correct while only a wholly-scanned document was ever queued, and
   * would now throw away 210 good pages of a manual to keep the four that were
   * recognised. The text-layer pages are kept, the recognised pages are added
   * beside them with `source: 'ocr'`, and the document's own source becomes
   * `mixed` when it holds both: a result from either has to be able to say
   * which it came from, because one is what the document says and the other is
   * a machine's reading of what it looks like.
   */
  const recognisedPages = outcome.pageTexts.map((page) => ({
    documentId: job.documentId,
    pageNumber: page.pageNumber,
    source: 'ocr' as const,
    characters: page.text.length,
    content: page.text,
  }));

  /*
   * THE KEPT PAGES ARE HANDED BACK WITH THEIR TEXT, because `saveTextIndex`
   * replaces the page rows wholesale — which is what stops a re-extraction
   * leaving pages it did not mention still searchable.
   */
  const mergedPages = [
    ...existingPages.filter((page) => page.content.length > 0),
    ...recognisedPages,
  ].sort((a, b) => a.pageNumber - b.pageNumber);

  const mergedText =
    mergedPages.length > 0
      ? mergedPages.map((page) => page.content).join('\n\n')
      : outcome.text;

  const pagesIndexed = mergedPages.length;
  const documentPages = Math.max(totalPages, outcome.pages, pagesIndexed);
  const holdsTextLayer = existingPages.some((page) => page.source === 'text_layer');

  const index = await context.repos.documents.saveTextIndex(
    {
      documentId: job.documentId,
      state:
        pagesIndexed > 0 && pagesIndexed < documentPages ? 'partially_indexed' : 'indexed',
      source: holdsTextLayer ? 'mixed' : 'ocr',
      extractedAt: context.services.clock.now(),
      characters: mergedText.length,
      pages: documentPages,
      pagesIndexed: pagesIndexed === 0 ? documentPages : pagesIndexed,
      /*
       * TRUNCATED IF THE ENGINE SAYS SO, OR IF IT READ FEWER PAGES THAN THE
       * DOCUMENT HAS.
       *
       * The engine now reports its own truncation, and it knows more than this
       * comparison can: a whole-document DEADLINE or a TEXT BUDGET stops it
       * mid-document for reasons the page count cannot show — and the page
       * bound itself is the engine's, not this function's. The comparison is
       * kept as well, because a document whose pages simply did not all
       * rasterise is also a partial index.
       */
      truncated: outcome.truncated || outcome.pages < document.pageCount,
      /*
       * PAGES THAT FAILED TO BE RECOGNISED, in the column the text-layer path
       * uses for streams it could not decompress. The same fact — "this many
       * parts of the document produced nothing" — so the same column, rather
       * than a second one that means almost the same thing.
       */
      unreadableStreams: outcome.pagesFailed,
      /*
       * WHY IT IS PARTIAL, where the engine said. An index marked truncated
       * with no reason sends somebody looking at the document.
       */
      failureReason: outcome.truncationReason,
    },
    mergedText,
    mergedPages,
  );

  const settled = await settle('done', '', outcome.engine);
  await audit(context, {
    jobId: null,
    type: 'document_indexed',
    summary: `Document indexed by text recognition: ${document.name}`,
    detail:
      `${outcome.pageTexts.length || outcome.pages} page(s) recognised by ${outcome.engine}` +
      `${pagesToRead.length === 0 ? '' : ` (pages ${pagesToRead.slice(0, 10).join(', ')}${pagesToRead.length > 10 ? ' and others' : ''}, the pages that carried no text)`}. ` +
      `${index.pagesIndexed} of ${index.pages} page(s) are now in the index` +
      `${index.truncated ? ', and it was cut short' : ''}. ` +
      'Recognised text can contain mistakes and is labelled as recognised wherever it is shown.',
  });

  return { job: settled, index };
};

/**
 * What the library should SAY about a revision's searchability.
 *
 * ONE FUNCTION, because the answer comes from two records and the combination
 * is easy to get subtly wrong in a component: the index says whether there is
 * text and the queue says whether anybody is going to try. "Not searchable"
 * and "not searchable yet, we are reading it" and "not searchable and nothing
 * on this server can read it" are three different things to a technician
 * looking for a manual, and only the last one means somebody has to go and
 * install something.
 */
export const describeSearchability = (
  index: DocumentTextIndex | null,
  job: OcrJob | null,
): { readonly searchable: boolean; readonly label: string; readonly detail: string } => {
  /*
   * PART OF THE DOCUMENT IS SEARCHABLE AND IT SAYS WHICH PART. LIB-TEXT-1.
   *
   * The ordinary shape of a real manual: typeset text with a scanned diagram
   * in it. Calling that `Searchable` would tell a technician the whole book
   * was read when four pages of it are pictures — and the four pages they most
   * often want are the wiring diagrams. The page tally is said out loud, and
   * `failureReason` carries which pages and why.
   */
  if (index !== null && index.state === 'partially_indexed') {
    const waiting =
      job !== null && (job.state === 'queued' || job.state === 'running')
        ? ' The rest is waiting for text recognition.'
        : job !== null && job.state === 'unavailable'
          ? ' Nothing on this server can read the remaining pages.'
          : '';
    return {
      searchable: true,
      label: `Searchable — ${index.pagesIndexed} of ${index.pages} pages`,
      detail:
        `${index.pagesIndexed} of this document's ${index.pages} pages are in the index. ` +
        `${index.failureReason}${waiting}`.trim(),
    };
  }

  if (index !== null && index.state === 'indexed') {
    /*
     * PART OF A DOCUMENT IS SEARCHABLE, AND IT SAYS WHICH PART.
     *
     * A whole-document deadline, a text budget or the page bound can stop
     * recognition before the document ends. `truncated` already said so; what
     * was missing was WHY, which the engine now reports — because somebody
     * searching a 214-page manual and not finding alarm 414 needs to know that
     * only the first forty pages were read, rather than concluding the alarm
     * is not in the book.
     */
    const partial =
      index.truncated && index.failureReason.length > 0 ? ` ${index.failureReason}` : '';
    return index.source === 'ocr'
      ? {
          searchable: true,
          label: index.truncated ? 'Searchable in part (recognised text)' : 'Searchable (recognised text)',
          detail:
            'The text was read off the scanned pages by text recognition, so it can contain ' +
            'mistakes. Search for a code more than one way if the first does not find it.' +
            partial,
        }
      : {
          searchable: true,
          label: index.truncated ? 'Searchable in part' : 'Searchable',
          detail: "The text came out of the document's own text layer." + partial,
        };
  }

  if (index !== null && index.state === 'failed') {
    return {
      searchable: false,
      label: 'Not searchable — the file could not be read',
      detail: index.failureReason,
    };
  }

  // From here the document has no text. What differs is whose problem that is.
  if (job !== null) {
    if (job.state === 'queued' || job.state === 'running') {
      return {
        searchable: false,
        label: job.state === 'running' ? 'Reading the pages now' : 'Waiting for text recognition',
        detail:
          'This document is a scan, so its text has to be recognised before it can be ' +
          'searched. It is not searchable yet.',
      };
    }
    if (job.state === 'unavailable') {
      return {
        searchable: false,
        label: 'Not searchable — no text recognition on this server',
        detail: job.lastError,
      };
    }
    if (job.state === 'failed') {
      return {
        searchable: false,
        label: 'Not searchable — the pages could not be read',
        detail:
          job.attempts >= OCR_MAX_ATTEMPTS
            ? `${job.lastError} Tried ${job.attempts} times and stopped. A clearer scan, or a copy with a text layer, would fix it.`
            : job.lastError,
      };
    }
    /*
     * `done` WITH NO TEXT ON THE INDEX. Recognition finished and the index was
     * not made `indexed` — which happens when a later re-extraction replaced
     * it. Said honestly rather than reported as searchable.
     */
    return {
      searchable: false,
      label: 'Not searchable',
      detail: 'Text recognition has run, and this revision holds no searchable text.',
    };
  }

  if (index !== null && index.state === 'needs_ocr') {
    return {
      searchable: false,
      label: 'Not searchable — scanned document',
      detail: `${index.failureReason} Nothing is queued to read it.`,
    };
  }

  return {
    searchable: false,
    label: 'Not indexed',
    detail: 'No file has been uploaded for this revision, so there is nothing to search.',
  };
};

/** Everything a caller needs to say what is waiting, without a second read. */
export interface OcrQueueSummary {
  readonly queued: number;
  readonly running: number;
  readonly failed: number;
  readonly unavailable: number;
  readonly done: number;
}

export const summariseOcrQueue = (jobs: readonly OcrJob[]): OcrQueueSummary => ({
  queued: jobs.filter((job) => job.state === 'queued').length,
  running: jobs.filter((job) => job.state === 'running').length,
  failed: jobs.filter((job) => job.state === 'failed').length,
  unavailable: jobs.filter((job) => job.state === 'unavailable').length,
  done: jobs.filter((job) => job.state === 'done').length,
});

/** The document a job is for, for a report that names documents not ids. */
export const documentsFor = async (
  context: OperationContext,
  jobs: readonly OcrJob[],
): Promise<ReadonlyMap<DocumentId, TechnicalDocument>> => {
  const found = new Map<DocumentId, TechnicalDocument>();
  for (const job of jobs) {
    const document = await context.repos.documents.findById(job.documentId);
    if (document !== null) found.set(job.documentId, document);
  }
  return found;
};
