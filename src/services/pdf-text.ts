import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractPdfText, MAX_INDEXED_CHARACTERS, MAX_PDF_BYTES } from '@/lib/pdf/extract-text';

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
}

export type PdfTextReading =
  | {
      readonly kind: 'text';
      /** The whole document's text, in page order. What the index holds. */
      readonly text: string;
      /** Per page, for an engine that can attribute it. Empty when it cannot. */
      readonly pages: readonly PdfPageText[];
      readonly totalPages: number;
      /**
       * Pages that carry no text at all, one-based. THE OCR CANDIDATES.
       *
       * A manual with a scanned wiring diagram on page 7 is this: 213 pages of
       * real text and one page of pixels. Naming them is what makes
       * recognition a 25-second job rather than an 83-minute one, and what
       * makes "partially searchable" a fact rather than a hedge.
       */
      readonly pagesWithoutText: readonly number[];
      /** True when the text was cut at a limit rather than the document ending. */
      readonly truncated: boolean;
      readonly unreadableStreams: number;
      readonly engine: string;
    }
  | {
      /** There is no text in this document at all. A scan. */
      readonly kind: 'needs_ocr';
      readonly reason: string;
      readonly totalPages: number;
      readonly pagesWithoutText: readonly number[];
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

/** `pdftotext` is given this long for one document. */
const EXTRACT_TIMEOUT_MS = 60_000;
/**
 * The most text one run may write back, and it is NOT the index budget.
 *
 * Tying the two together was a real defect: a small `maxCharacters` meant a
 * tiny `maxBuffer`, `spawnSync` failed with ENOBUFS, and a document that was
 * merely going to be TRUNCATED was reported as one that could not be read. The
 * index budget decides how much is KEPT; this decides how much the server will
 * hold while deciding, and a manual's text is a megabyte or two at most.
 */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/** A page with fewer than this many non-space characters is a page of pixels. */
const MIN_PAGE_CHARACTERS = 8;

const whole = (version: string): string => version.split('\n')[0]?.trim() ?? version;

const binaryVersion = (binary: string): string | null => {
  // `pdftotext -v` writes its version to stderr and exits non-zero on some
  // builds, so the output rather than the status is what is read.
  const result = spawnSync(binary, ['-v'], { encoding: 'utf8', timeout: 15_000 });
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
        unreadableStreams: outcome.unreadableStreams,
        engine,
      };
    }
    return {
      kind: 'text',
      text: outcome.text,
      pages: [],
      totalPages: outcome.pages,
      pagesWithoutText: [],
      truncated: outcome.truncated,
      unreadableStreams: outcome.unreadableStreams,
      engine,
    };
  },
});

export interface PopplerPdfTextConfig {
  /** Path to `pdftotext`, or the bare name to find it on PATH. */
  readonly binary?: string;
  readonly maxInputBytes?: number;
  readonly maxCharacters?: number;
}

/**
 * `pdftotext`, as a local process. MASTER SCOPE LIB-TEXT-1.
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
 */
export const popplerPdfText = (config: PopplerPdfTextConfig = {}): PdfTextService => {
  const binary = config.binary ?? 'pdftotext';
  const maxInputBytes = config.maxInputBytes ?? MAX_PDF_BYTES;
  const maxCharacters = config.maxCharacters ?? MAX_INDEXED_CHARACTERS;

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

      if (pdf.byteLength > maxInputBytes) {
        return {
          kind: 'failed',
          engine: capability.engine,
          reason:
            `The file is ${Math.round(pdf.byteLength / (1024 * 1024))} MB, and this server reads ` +
            `up to ${Math.round(maxInputBytes / (1024 * 1024))} MB of PDF at a time.`,
        };
      }

      const workspace = mkdtempSync(join(tmpdir(), 'eje-pdftext-'));
      try {
        const source = join(workspace, 'document.pdf');
        writeFileSync(source, pdf, { mode: 0o600 });

        const run = spawnSync(binary, ['-enc', 'UTF-8', '-layout', '-q', source, '-'], {
          timeout: EXTRACT_TIMEOUT_MS,
          encoding: 'utf8',
          maxBuffer: MAX_OUTPUT_BYTES,
        });

        if (run.error !== undefined || run.status !== 0) {
          /*
           * EVERY FAILURE NAMED, because "could not read it" sends somebody
           * looking at the document when the answer is a password or a bound.
           * `pdftotext` writes its own diagnosis to stderr and it is better
           * than anything invented here.
           */
          const said = `${run.stderr ?? ''}`.trim();
          const encrypted = /password|encrypt/iu.test(said);
          const overflowed = (run.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS';
          return {
            kind: 'failed',
            engine: capability.engine,
            reason: encrypted
              ? 'This PDF is password-protected, so its text cannot be read. Upload an ' +
                'unprotected copy if it is to be searchable.'
              : overflowed
                ? `This PDF produced more than ${Math.round(MAX_OUTPUT_BYTES / (1024 * 1024))} MB ` +
                  'of text, which is more than a manual holds. It has not been indexed.'
                : said.length === 0
                  ? 'The file could not be read as a PDF. It may be damaged.'
                  : `The file could not be read: ${said.slice(0, 300)}`,
          };
        }

        /*
         * THE FORM FEED IS THE PAGE BREAK, and the trailing one produces an
         * empty final chunk that is not a page. Dropping it is the difference
         * between a 10-page manual and an 11-page one with a blank at the end
         * reported as needing recognition.
         */
        const chunks = (run.stdout ?? '').split('\f');
        if (chunks.length > 1 && chunks[chunks.length - 1]?.trim() === '') chunks.pop();

        const pages: PdfPageText[] = [];
        const pagesWithoutText: number[] = [];
        let characters = 0;
        let truncated = false;

        chunks.forEach((chunk, offset) => {
          const pageNumber = offset + 1;
          const text = chunk.replace(/\u0000/gu, '').trimEnd();
          if (text.replace(/\s+/gu, '').length < MIN_PAGE_CHARACTERS) {
            pagesWithoutText.push(pageNumber);
            return;
          }
          if (characters >= maxCharacters) {
            truncated = true;
            return;
          }
          const room = maxCharacters - characters;
          const kept = text.length > room ? text.slice(0, room) : text;
          truncated = truncated || kept.length < text.length;
          characters += kept.length;
          pages.push({ pageNumber, text: kept });
        });

        const totalPages = chunks.length;

        if (pages.length === 0) {
          return {
            kind: 'needs_ocr',
            engine: capability.engine,
            totalPages,
            pagesWithoutText,
            unreadableStreams: 0,
            reason:
              `No text could be read from any of the ${totalPages} page(s): this is a scan, ` +
              'and it needs text recognition to be searchable.',
          };
        }

        return {
          kind: 'text',
          // The index holds the document; the page rows hold where each part
          // of it was. One join, in page order, so a phrase that crosses a
          // page break still matches the document.
          text: pages.map((page) => page.text).join('\n\n'),
          pages,
          totalPages,
          pagesWithoutText,
          truncated,
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
