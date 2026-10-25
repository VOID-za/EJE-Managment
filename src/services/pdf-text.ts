import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractPdfText, MAX_INDEXED_CHARACTERS, MAX_PDF_BYTES } from '@/lib/pdf/extract-text';
import { formatNumber } from '@/lib/format';

/**
 * READING THE TEXT A PDF ALREADY CONTAINS. MASTER SCOPE LIB-5, LIB-TEXT-1.
 *
 * WHY THIS EXISTS, AND IT IS NOT A REFACTOR. EJE's library will hold
 * MANUFACTURER MANUALS — drive manuals, service procedures, wiring
 * documentation, safety procedures — not scanned paperwork. Ordinary text
 * extraction is therefore the PRIMARY search path and recognition is the
 * fallback, and the extractor that shipped could not read the primary case.
 *
 * THE MEASURED DEFECT. `src/lib/pdf/extract-text.ts` reads the bytes itself and
 * states honestly that it cannot map a CID font: a PDF whose fonts are subset
 * with `Identity-H` encoding stores GLYPH IDS rather than characters, and
 * reading them without the font's `/ToUnicode` map yields mojibake. That is
 * not an edge case — it is what Acrobat, InDesign and FrameMaker all produce,
 * which is to say nearly every manual a machine builder ships. On a document
 * encoded that way (a fixture is in `__fixtures__/cid-manual.pdf`, built the
 * same way a real one is) the built-in reader reports:
 *
 *     needs_ocr — "7% readable, which means the fonts carry no usable encoding"
 *
 * and `pdftotext` on the same bytes returns the sentence. The consequence was
 * not merely a missed index: the document was then QUEUED FOR RECOGNITION, at
 * the 23–25 seconds per page BD-21 measured, so a 214-page manual full of
 * perfectly good text became an 83-minute job that the page bound stops at page
 * 40 anyway. The library would have reported EJE's own manuals as "not
 * searchable yet".
 *
 * TWO ADAPTERS, AND THE BETTER ONE IS THE DEFAULT WHEN IT IS THERE:
 *
 *   - `popplerPdfText()` — `pdftotext`, a local process. It resolves
 *     `/ToUnicode`, object streams (`/ObjStm`, which the built-in reader also
 *     cannot walk) and cross-reference streams, and it reports text PER PAGE,
 *     which is what lets a search result say page 212 and lets recognition be
 *     aimed at the three pages that are scans instead of the whole book.
 *   - `builtinPdfText()` — the byte reader, unchanged, for a deployment with no
 *     poppler. It cannot attribute text to a page, and says so rather than
 *     guessing: `perPage` is false and no page detail is recorded.
 *
 * NOTHING LEAVES THE MACHINE in either case. `pdftotext` is the same
 * poppler-utils package the rasteriser already needs, so on a server set up for
 * recognition this adapter costs nothing new to install.
 */

/** What an engine says about itself, before it is asked to read anything. */
export interface PdfTextCapability {
  /** How the engine names itself, e.g. `pdftotext version 24.02.0`. */
  readonly engine: string;
  /**
   * True when text can be attributed to the page it came from.
   *
   * False is not a failure — it is the built-in reader being honest. A search
   * result then names the document without naming the page, which is what the
   * library did for its first three releases.
   */
  readonly perPage: boolean;
  /** Why a better engine is not in use. Empty when the best one is. */
  readonly reason: string;
}

/** Text found on one page, numbered as a person would number it. */
export interface PdfPageText {
  /** One-based, as printed. */
  readonly pageNumber: number;
  readonly text: string;
  /** True when this page's text was cut at `maxPageCharacters`. */
  readonly truncated?: boolean;
}

/**
 * THE LIMITS ON ONE READING, EACH ONE NAMED. LIB-TEXT-1 (#70).
 *
 * WHAT CHANGED, AND WHY. Every page used to share ONE running budget —
 * `MAX_INDEXED_CHARACTERS`, 400 000 characters for the whole document — so an
 * ordinary 214-page manual stopped being indexed at page 96 and pages 97–214
 * could not be found by a search. That budget existed for a real reason: the
 * document's text went into ONE `tsvector`, and PostgreSQL refuses a tsvector
 * over a megabyte. The search now runs over the PER-PAGE vectors
 * (`library_document_pages`), so no single value has to hold the whole book,
 * and the whole-document budget stops being the reason anything is missing.
 *
 * WHAT IS LEFT are the bounds a server genuinely needs on a file somebody
 * chose, each of which stops the reading at a page boundary and is REPORTED —
 * never silently applied:
 *
 *   maxInputBytes          the file itself (40 MB, `MAX_PDF_BYTES`)
 *   maxPages               pages read from one document (5 000)
 *   maxPageCharacters      text kept from one page (100 000 — a dense A4 page
 *                          is 5–15 000; the bound keeps one page's vector far
 *                          below PostgreSQL's limit)
 *   maxDocumentCharacters  text held for one document while reading
 *                          (25 000 000 — about 6 000 ordinary manual pages; a
 *                          memory bound, not an index budget)
 *   deadlineMs             wall-clock time for the whole reading (120 s; a
 *                          214-page manual takes 0.2 s)
 *   batchPages             pages per `pdftotext` run (200), which is what
 *                          bounds the memory of one run and lets a reading
 *                          stopped by the deadline keep every batch it finished
 */
export interface PdfTextLimits {
  readonly maxInputBytes: number;
  readonly maxPages: number;
  readonly maxPageCharacters: number;
  readonly maxDocumentCharacters: number;
  readonly deadlineMs: number;
  readonly batchPages: number;
}

export const PDF_TEXT_LIMITS: PdfTextLimits = {
  maxInputBytes: MAX_PDF_BYTES,
  maxPages: 5_000,
  maxPageCharacters: 100_000,
  maxDocumentCharacters: 25_000_000,
  deadlineMs: 120_000,
  batchPages: 200,
};

/**
 * The document-level text kept on `library_document_text.content`.
 *
 * NO LONGER A SEARCH LIMIT for an engine that reads per page: a document with
 * page rows is searched through its pages. It is the document's SUMMARY — the
 * one column the database requires to be non-empty for a searchable state —
 * and it is bounded because it is still one tsvector. The built-in reader,
 * which cannot attribute text to pages, still searches this column, and still
 * says when it was cut.
 */
export const DOCUMENT_SUMMARY_CHARACTERS = MAX_INDEXED_CHARACTERS;

/** Which bound stopped or cut a reading, and a sentence somebody can act on. */
export interface PdfTextLimitHit {
  readonly kind: 'pages' | 'deadline' | 'document_characters' | 'page_characters' | 'output' | 'read_error';
  readonly message: string;
}

export type PdfTextReading =
  | {
      readonly kind: 'text';
      /**
       * The document-level summary, in page order, at most
       * `DOCUMENT_SUMMARY_CHARACTERS`. For an engine that reads per page the
       * INDEX is `pages`; this is not where a later page has to fit.
       */
      readonly text: string;
      /** Per page, for an engine that can attribute it. Empty when it cannot. */
      readonly pages: readonly PdfPageText[];
      readonly totalPages: number;
      /**
       * False when the reading stopped early AND nothing could say how long
       * the document is (no `pdfinfo`). `totalPages` is then a lower bound —
       * the pages read plus the one it stopped before — and the reason says so.
       */
      readonly totalPagesKnown: boolean;
      /** Pages examined, with text or without. Equal to `totalPages` when complete. */
      readonly pagesRead: number;
      /**
       * True when every page of the document was examined. FALSE MEANS SOME
       * PAGES WERE NEVER LOOKED AT — which is not the same as pages without
       * text, and is why recognition is not queued for an incomplete reading.
       */
      readonly complete: boolean;
      /**
       * Pages that carry no text at all, one-based, AMONG THE PAGES READ. THE
       * OCR CANDIDATES.
       *
       * A manual with a scanned wiring diagram on page 7 is this: 213 pages of
       * real text and one page of pixels. Naming them is what makes
       * recognition a 25-second job rather than an 83-minute one, and what
       * makes "partially searchable" a fact rather than a hedge.
       */
      readonly pagesWithoutText: readonly number[];
      /** True when any text was cut or any page left unread because of a limit. */
      readonly truncated: boolean;
      /** Every bound that cut or stopped this reading, in the order met. */
      readonly limits: readonly PdfTextLimitHit[];
      readonly unreadableStreams: number;
      readonly engine: string;
    }
  | {
      /** No text was found on any page that was read. A scan. */
      readonly kind: 'needs_ocr';
      readonly reason: string;
      readonly totalPages: number;
      readonly pagesWithoutText: readonly number[];
      /** As on `text`: false means some pages were never examined. */
      readonly complete: boolean;
      readonly unreadableStreams: number;
      readonly engine: string;
    }
  /** Nothing could be read: encrypted, damaged, or beyond a bound. */
  | { readonly kind: 'failed'; readonly reason: string; readonly engine: string };

export interface PdfTextService {
  describe(): PdfTextCapability;
  /**
   * Reads what the document says. It must not throw for anything about the
   * document: an unreadable file is `failed` with a reason, a scan is
   * `needs_ocr`. Both are outcomes the index records, and an exception would
   * turn either into a failed upload of a document the library should hold.
   */
  read(pdf: Uint8Array): PdfTextReading;
}

/**
 * The most text ONE BATCH may write back, and it is NOT the index budget.
 *
 * Tying the two together was a real defect: a small `maxCharacters` meant a
 * tiny `maxBuffer`, `spawnSync` failed with ENOBUFS, and a document that was
 * merely going to be TRUNCATED was reported as one that could not be read. The
 * limits decide how much is KEPT; this decides how much the server will hold
 * while one batch of `batchPages` is read. 200 ordinary pages are about a
 * megabyte; this is room for pages far denser than any manual.
 */
const MAX_BATCH_OUTPUT_BYTES = 64 * 1024 * 1024;
/** A page with fewer than this many non-space characters is a page of pixels. */
const MIN_PAGE_CHARACTERS = 8;

const whole = (version: string): string => version.split('\n')[0]?.trim() ?? version;

/*
 * `/*turbopackIgnore: true*\/` ON EVERY SPAWN AND FILE WRITE IN THIS MODULE.
 *
 * The binary is a command on the server's PATH and the file is a temporary
 * copy of an upload — neither is part of the application. Without the comment
 * Turbopack's static analysis cannot tell where they point and traces the
 * WHOLE PROJECT into the server output ("Dynamic filesystem access causes
 * tracing of the whole project"), which is the build warning this file used to
 * produce. Turbopack's own message names this comment as the fix.
 */
const binaryVersion = (binary: string): string | null => {
  // `pdftotext -v` writes its version to stderr and exits non-zero on some
  // builds, so the output rather than the status is what is read.
  const result = spawnSync(/*turbopackIgnore: true*/ binary, ['-v'], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (result.error !== undefined) return null;
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return output.length === 0 ? null : whole(output);
};

/**
 * The byte reader, wrapped in the port. Unchanged behaviour.
 *
 * It reports a page COUNT but cannot say which page a word was on, so no page
 * detail is produced and `pagesWithoutText` is empty — not because every page
 * has text, but because this engine does not know. Recording an empty list is
 * the honest answer; recording every page as a candidate would send a 214-page
 * manual to recognition for no reason.
 */
export const builtinPdfText = (reason = ''): PdfTextService => ({
  describe: () => ({ engine: 'built-in PDF reader', perPage: false, reason }),
  read: (pdf) => {
    const outcome = extractPdfText(pdf);
    const engine = 'built-in PDF reader';
    if (outcome.kind === 'failed') return { kind: 'failed', reason: outcome.reason, engine };
    if (outcome.kind === 'needs_ocr') {
      return {
        kind: 'needs_ocr',
        reason: outcome.reason,
        totalPages: outcome.pages,
        pagesWithoutText: [],
        // It reads the whole file or stops at a byte bound it reports as
        // `failed`, so a `needs_ocr` from it has looked at everything.
        complete: true,
        unreadableStreams: outcome.unreadableStreams,
        engine,
      };
    }
    /*
     * CUT AT THE SUMMARY BUDGET, AND IT CANNOT SAY WHICH PAGES. LIB-TEXT-1.
     *
     * This reader has no page rows, so its one document-level vector IS its
     * index, and that vector is still bounded. When it is cut the reading is
     * NOT complete — the caller records the document as partially indexed with
     * the page coverage unknown, rather than as indexed.
     */
    return {
      kind: 'text',
      text: outcome.text,
      pages: [],
      totalPages: outcome.pages,
      totalPagesKnown: true,
      pagesRead: outcome.truncated ? 0 : outcome.pages,
      complete: !outcome.truncated,
      pagesWithoutText: [],
      truncated: outcome.truncated,
      limits: outcome.truncated
        ? [
            {
              kind: 'document_characters',
              message:
                `This server has no pdftotext, and the built-in reader keeps only the first ` +
                `${formatNumber(DOCUMENT_SUMMARY_CHARACTERS, 0)} characters of a document ` +
                'and cannot tell which pages they came from, so the rest is not searchable. ' +
                'Install poppler-utils on the server to index every page.',
            },
          ]
        : [],
      unreadableStreams: outcome.unreadableStreams,
      engine,
    };
  },
});

export interface PopplerPdfTextConfig {
  /** Path to `pdftotext`, or the bare name to find it on PATH. */
  readonly binary?: string;
  /**
   * Path to `pdfinfo`, which says how many pages the document has before any
   * are read. Defaults to the `pdfinfo` beside `binary` (both are in
   * poppler-utils). Absent is not fatal: the reading finds the end by reading
   * to it, and says when it could not.
   */
  readonly pdfinfoBinary?: string;
  /** Any bound to override, for a test or a deliberately different server. */
  readonly limits?: Partial<PdfTextLimits>;
  /** The clock the deadline is measured on. A test seam. */
  readonly now?: () => number;
}

/** `pdfinfo` sits beside `pdftotext` — the same directory and the same suffix. */
const siblingPdfinfo = (binary: string): string =>
  binary.replace(/pdftotext(\.exe)?$/iu, (_match, exe: string | undefined) => `pdfinfo${exe ?? ''}`);

/** The document's page count from `pdfinfo`, or null when it cannot say. */
const pageCountOf = (pdfinfo: string, source: string, timeoutMs: number): number | null => {
  if (timeoutMs <= 0) return null;
  const run = spawnSync(/*turbopackIgnore: true*/ pdfinfo, [source], {
    encoding: 'utf8',
    timeout: Math.min(timeoutMs, 15_000),
    maxBuffer: 1024 * 1024,
  });
  if (run.error !== undefined || run.status !== 0) return null;
  const match = /^Pages:\s+(\d+)\s*$/mu.exec(run.stdout ?? '');
  return match === null ? null : Number(match[1]);
};

const plural = (count: number, word: string): string =>
  `${formatNumber(count, 0)} ${word}${count === 1 ? '' : 's'}`;

/**
 * `pdftotext`, as a local process, READ IN BATCHES. MASTER SCOPE LIB-TEXT-1.
 *
 * `-layout` keeps the reading order of a two-column manual, which matters for a
 * snippet a person reads; `-enc UTF-8` is what makes the degree, micro and
 * plus-minus signs machine documentation is full of come out as themselves.
 * The PDF goes to a temporary directory removed in a `finally` — a customer's
 * drawing must not be left as a loose file for somebody to find.
 *
 * THE PAGE SPLIT IS THE TOOL'S OWN. `pdftotext` writes a form feed (0x0C)
 * after each page, so the pages are the tool's answer and not a guess about
 * where one ended.
 *
 * WHY BATCHES (`-f`/`-l`, `batchPages` at a time). One run over a 3 000-page
 * manual holds all of its text in one buffer and, if the deadline kills it,
 * leaves nothing. A batch at a time bounds the memory of each run, makes the
 * deadline a point at which the reading STOPS rather than fails, and keeps
 * every page already read. The count comes from `pdfinfo` where it is
 * installed; without it the end is found by asking for more pages than are
 * left (poppler clamps the last page of a range, xpdf does too, and poppler
 * refuses a range that STARTS past the end — both are read as "the end").
 */
export const popplerPdfText = (config: PopplerPdfTextConfig = {}): PdfTextService => {
  const binary = config.binary ?? 'pdftotext';
  const pdfinfo = config.pdfinfoBinary ?? siblingPdfinfo(binary);
  const limits: PdfTextLimits = { ...PDF_TEXT_LIMITS, ...config.limits };
  const now = config.now ?? Date.now;

  const describe = (): PdfTextCapability => {
    const version = binaryVersion(binary);
    if (version === null) {
      return {
        engine: 'none',
        perPage: false,
        reason:
          `Reading the text out of a PDF needs ${binary} (package poppler-utils), which is not ` +
          'installed on this server. The built-in reader is being used instead, which cannot ' +
          'read a manual whose fonts are subset — see docs/library-ocr.md.',
      };
    }
    return { engine: version, perPage: true, reason: '' };
  };

  return {
    describe,
    read: (pdf) => {
      const capability = describe();
      // Not a refusal: a missing binary falls back to the reader that is
      // always there, so a deployment without poppler indexes what it can.
      if (capability.engine === 'none') return builtinPdfText(capability.reason).read(pdf);

      if (pdf.byteLength > limits.maxInputBytes) {
        return {
          kind: 'failed',
          engine: capability.engine,
          reason:
            `The file is ${Math.round(pdf.byteLength / (1024 * 1024))} MB, and this server reads ` +
            `up to ${Math.round(limits.maxInputBytes / (1024 * 1024))} MB of PDF at a time. ` +
            'Split the document, or upload a copy saved without embedded images.',
        };
      }

      const started = now();
      const remaining = (): number => limits.deadlineMs - (now() - started);
      const workspace = mkdtempSync(join(tmpdir(), 'eje-pdftext-'));
      try {
        const source = join(workspace, 'document.pdf');
        writeFileSync(/*turbopackIgnore: true*/ source, pdf, { mode: 0o600 });

        const counted = pageCountOf(pdfinfo, source, remaining());

        const pages: PdfPageText[] = [];
        const pagesWithoutText: number[] = [];
        const cutPages: number[] = [];
        const hits: PdfTextLimitHit[] = [];
        let characters = 0;
        let pagesRead = 0;
        let reachedEnd = false;

        for (let first = 1; ; first += limits.batchPages) {
          if (counted !== null && first > counted) {
            reachedEnd = true;
            break;
          }
          if (first > limits.maxPages) {
            hits.push({
              kind: 'pages',
              message:
                `Only the first ${plural(limits.maxPages, 'page')} are read from one document on ` +
                'this server, so the pages after that are not searchable. Split the document to ' +
                'index the rest.',
            });
            break;
          }
          const budget = remaining();
          if (budget <= 0) {
            hits.push({
              kind: 'deadline',
              message:
                `Reading stopped after ${Math.round(limits.deadlineMs / 1000)} seconds, at page ` +
                `${pagesRead}, so the pages after that are not searchable. Upload the document ` +
                'again to retry, or split it.',
            });
            break;
          }

          const last = Math.min(
            first + limits.batchPages - 1,
            limits.maxPages,
            counted ?? Number.POSITIVE_INFINITY,
          );
          const run = spawnSync(
            /*turbopackIgnore: true*/ binary,
            ['-enc', 'UTF-8', '-layout', '-q', '-f', String(first), '-l', String(last), source, '-'],
            { timeout: budget, encoding: 'utf8', maxBuffer: MAX_BATCH_OUTPUT_BYTES },
          );

          if (run.error !== undefined || run.status !== 0) {
            const said = `${run.stderr ?? ''}`.trim();
            const code = (run.error as NodeJS.ErrnoException | undefined)?.code;

            /*
             * A RANGE THAT STARTS PAST THE END is poppler's way of saying the
             * previous batch was the last, when no page count was available.
             */
            if (first > 1 && counted === null && /wrong page range/iu.test(said)) {
              reachedEnd = true;
              break;
            }
            /*
             * ON THE FIRST BATCH, EVERY FAILURE IS THE DOCUMENT'S AND IS NAMED,
             * because "could not read it" sends somebody looking at the
             * document when the answer is a password or a bound. `pdftotext`
             * writes its own diagnosis to stderr and it is better than
             * anything invented here.
             */
            if (first === 1 && pagesRead === 0 && code !== 'ETIMEDOUT') {
              const encrypted = /password|encrypt/iu.test(said);
              return {
                kind: 'failed',
                engine: capability.engine,
                reason: encrypted
                  ? 'This PDF is password-protected, so its text cannot be read. Upload an ' +
                    'unprotected copy if it is to be searchable.'
                  : code === 'ENOBUFS'
                    ? `The first ${plural(last, 'page')} of this PDF produced more than ` +
                      `${Math.round(MAX_BATCH_OUTPUT_BYTES / (1024 * 1024))} MB of text, which is ` +
                      'more than any manual holds. It has not been indexed.'
                    : said.length === 0
                      ? 'The file could not be read as a PDF. It may be damaged.'
                      : `The file could not be read: ${said.slice(0, 300)}`,
              };
            }
            /* LATER BATCHES STOP THE READING AND KEEP EVERYTHING BEFORE THEM. */
            hits.push(
              code === 'ETIMEDOUT'
                ? {
                    kind: 'deadline',
                    message:
                      `Reading stopped after ${Math.round(limits.deadlineMs / 1000)} seconds, at ` +
                      `page ${pagesRead}, so the pages after that are not searchable. Upload the ` +
                      'document again to retry, or split it.',
                  }
                : code === 'ENOBUFS'
                  ? {
                      kind: 'output',
                      message:
                        `Pages ${first}–${last} produced more text than one read may hold, so ` +
                        `reading stopped at page ${pagesRead}. Those pages are unusually dense; ` +
                        'split the document to index them.',
                    }
                  : {
                      kind: 'read_error',
                      message:
                        `Pages from ${first} on could not be read (${said.slice(0, 200) || 'no ' +
                        'reason given'}), so they are not searchable. The file may be damaged ` +
                        'after that point.',
                    },
            );
            break;
          }

          /*
           * THE FORM FEED IS THE PAGE BREAK, and the trailing one produces an
           * empty final chunk that is not a page. Dropping it is the difference
           * between a 10-page manual and an 11-page one with a blank at the end
           * reported as needing recognition.
           */
          const chunks = (run.stdout ?? '').split('\f');
          if (chunks.length > 0 && chunks[chunks.length - 1]?.trim() === '') chunks.pop();

          let stopped = false;
          for (const [offset, chunk] of chunks.entries()) {
            const pageNumber = first + offset;
            const text = chunk.replace(/\u0000/gu, '').trimEnd();
            pagesRead = pageNumber;
            if (text.replace(/\s+/gu, '').length < MIN_PAGE_CHARACTERS) {
              pagesWithoutText.push(pageNumber);
              continue;
            }
            if (characters + Math.min(text.length, limits.maxPageCharacters) > limits.maxDocumentCharacters) {
              // This page is NOT read: the count says the pages before it.
              pagesRead = pageNumber - 1;
              hits.push({
                kind: 'document_characters',
                message:
                  `This document holds more than ` +
                  `${formatNumber(limits.maxDocumentCharacters, 0)} characters of text, ` +
                  `which is more than one document may contribute, so reading stopped at page ` +
                  `${pagesRead}. Split the document to index the rest.`,
              });
              stopped = true;
              break;
            }
            const cut = text.length > limits.maxPageCharacters;
            const kept = cut ? text.slice(0, limits.maxPageCharacters) : text;
            if (cut) cutPages.push(pageNumber);
            characters += kept.length;
            pages.push(cut ? { pageNumber, text: kept, truncated: true } : { pageNumber, text: kept });
          }
          if (stopped) break;

          // Fewer pages than asked for: this batch reached the end of the book.
          const asked = last - first + 1;
          if (chunks.length < asked || (counted !== null && last >= counted)) {
            reachedEnd = true;
            break;
          }
        }

        if (cutPages.length > 0) {
          const named =
            cutPages.length <= 5 ? `page${cutPages.length === 1 ? '' : 's'} ${cutPages.join(', ')}` : plural(cutPages.length, 'page');
          hits.push({
            kind: 'page_characters',
            message:
              `${named[0]?.toUpperCase()}${named.slice(1)} held more than ` +
              `${formatNumber(limits.maxPageCharacters, 0)} characters, and only that much ` +
              'of each is searchable.',
          });
        }

        const complete = reachedEnd;
        // Without a count, a reading that stopped early knows only that at
        // least one more page exists — and says so (`totalPagesKnown`).
        const totalPagesKnown = counted !== null || complete;
        const totalPages = counted ?? (complete ? pagesRead : pagesRead + 1);
        if (!totalPagesKnown) {
          hits.push({
            kind: 'pages',
            message:
              `The document continues past page ${pagesRead}, and how many pages it has could ` +
              'not be read on this server (pdfinfo, part of poppler-utils, is not installed).',
          });
        }

        if (pages.length === 0) {
          return {
            kind: 'needs_ocr',
            engine: capability.engine,
            totalPages,
            pagesWithoutText,
            complete,
            unreadableStreams: 0,
            reason: complete
              ? `No text could be read from any of the ${plural(totalPages, 'page')}: this is a ` +
                'scan, and it needs text recognition to be searchable.'
              : `No text was found on the ${plural(pagesRead, 'page')} that could be read before ` +
                `a limit stopped the reading. ${hits.map((hit) => hit.message).join(' ')}`,
          };
        }

        /*
         * THE SUMMARY, NOT THE INDEX. One join in page order, bounded, because
         * it is still one tsvector. Every page is in `pages`, which is what a
         * search reads.
         */
        let summary = '';
        for (const page of pages) {
          const next = summary.length === 0 ? page.text : `${summary}\n\n${page.text}`;
          if (next.length > DOCUMENT_SUMMARY_CHARACTERS) {
            summary = next.slice(0, DOCUMENT_SUMMARY_CHARACTERS);
            break;
          }
          summary = next;
        }

        return {
          kind: 'text',
          text: summary,
          pages,
          totalPages,
          totalPagesKnown,
          pagesRead,
          complete,
          pagesWithoutText,
          truncated: hits.length > 0,
          limits: hits,
          unreadableStreams: 0,
          engine: capability.engine,
        };
      } catch (cause) {
        return {
          kind: 'failed',
          engine: capability.engine,
          reason: `The file could not be read: ${cause instanceof Error ? cause.message : 'unknown error'}.`,
        };
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    },
  };
};

/**
 * The engine this deployment reads PDFs with.
 *
 * POPPLER WHEN IT IS THERE, which is the default and needs no configuration:
 * unlike recognition, extracting text that is already in the file costs
 * milliseconds, sends nothing anywhere and has no decision attached to it — so
 * the better engine is not behind a switch. `EJE_PDF_TEXT=builtin` forces the
 * byte reader (for a machine where `pdftotext` is present but unwanted), and
 * any other value is refused loudly rather than silently ignored, because a
 * misspelt setting must not quietly change which engine reads EJE's manuals.
 */
export const buildPdfText = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): PdfTextService => {
  const configured = (env.EJE_PDF_TEXT ?? '').trim().toLowerCase();
  if (configured === 'builtin') {
    return builtinPdfText('EJE_PDF_TEXT=builtin: the byte reader was asked for by configuration.');
  }
  if (configured !== '' && configured !== 'auto' && configured !== 'poppler') {
    return builtinPdfText(
      `EJE_PDF_TEXT is set to "${configured}", which is not an engine this build knows. ` +
        'The values are `auto` (the default), `poppler` and `builtin`. The built-in reader is ' +
        'being used, which cannot read a manual whose fonts are subset.',
    );
  }
  return popplerPdfText({
    ...(env.EJE_PDF_TEXT_BINARY === undefined ? {} : { binary: env.EJE_PDF_TEXT_BINARY }),
  });
};
