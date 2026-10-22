import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Whole megabytes, for a message a person reads. */
const megabytes = (bytes: number): number => Math.round(bytes / (1024 * 1024));

/**
 * READING THE PIXELS OF A SCANNED DOCUMENT. MASTER SCOPE LIB-5.
 *
 * WHAT THIS IS NOT. It is not a decision to do OCR. `docs/library-ocr.md`
 * costs the three options and recommends counting the unsearchable documents
 * first, because on a real library the number may be nil. This is the port and
 * the one adapter that can be built without EJE paying anybody or sending a
 * customer's drawings off the premises — the rest is a decision.
 *
 * WHY A PORT. So the queue, the worker and every test can be written and proved
 * against a stub, and the engine can be swapped without any of them changing.
 * It is the same shape as every other service in `src/services/ports.ts`.
 *
 * TWO ADAPTERS:
 *
 *   - `unavailableOcr()` — the DEFAULT, and the honest one. It recognises
 *     nothing and says what would have to be installed. A deployment with no
 *     engine behaves correctly rather than appearing to work.
 *   - `localOcr()` — `pdftoppm` to rasterise and `tesseract` to recognise, both
 *     run as local processes. Nothing leaves the machine. If either binary is
 *     absent it reports itself unavailable and NAMES THE PACKAGE, because
 *     "OCR failed" sends somebody looking at the document and "tesseract-ocr
 *     is not installed" sends them to the right place.
 *
 * NO HOSTED SERVICE IS IMPLEMENTED, deliberately. The mandate forbids sending
 * EJE's documents to an external provider without explicit approval, and a
 * half-built client for one would be a thing somebody switches on.
 */

/** What an engine says about itself, before it is asked to do anything. */
export interface OcrCapability {
  /** False when nothing on this machine can recognise text. */
  readonly available: boolean;
  /** How the engine names itself, e.g. `tesseract 5.3.0`. Recorded on the job. */
  readonly engine: string;
  /** Why it is unavailable, in words an operator can act on. Empty when it is. */
  readonly reason: string;
}

export type OcrOutcome =
  /** Pixels were read and produced text. */
  | {
      readonly kind: 'text';
      readonly text: string;
      /** Pages that produced text. */
      readonly pages: number;
      readonly engine: string;
      /**
       * True when a LIMIT stopped the read, rather than the document ending.
       *
       * The page bound, the whole-document deadline or the text budget. The
       * index records it, so a partial index says it is partial instead of
       * passing as a whole one.
       */
      readonly truncated: boolean;
      /** Which limit, in words, when one bit. Empty when none did. */
      readonly truncationReason: string;
      /** Pages that were attempted and produced nothing, with why. */
      readonly pagesFailed: number;
    }
  /**
   * The engine ran and produced nothing usable.
   *
   * A blank scan, a photograph of a wall, a page of a language with no trained
   * data. It is a fact about the document, so it is a failure of the job and
   * the reason says which.
   */
  | { readonly kind: 'empty'; readonly reason: string; readonly engine: string }
  /** Nothing could be asked. An installation problem, not a document problem. */
  | { readonly kind: 'unavailable'; readonly reason: string };

export interface OcrService {
  describe(): OcrCapability;
  /**
   * Reads a PDF's pages and returns what it found.
   *
   * It is handed the BYTES rather than a storage key: the worker has already
   * read them, and an engine that could reach storage would be an engine that
   * could read a document it was not asked about.
   *
   * It must not throw for anything about the document. A page that cannot be
   * read is `empty` with a reason; an engine that is not there is
   * `unavailable`. Both are outcomes the queue records, and an exception would
   * turn either into a crashed worker.
   */
  read(pdf: Uint8Array, options?: { readonly maxPages?: number }): Promise<OcrOutcome>;
}

/** The default. Recognises nothing, and says what would be needed. */
export const unavailableOcr = (
  reason = 'No text-recognition engine is configured on this server. ' +
    'Install `tesseract-ocr` and `poppler-utils` and set EJE_OCR=local — see docs/library-ocr.md.',
): OcrService => ({
  describe: () => ({ available: false, engine: 'none', reason }),
  read: () => Promise.resolve({ kind: 'unavailable', reason }),
});

/**
 * How many pages one job will read, unless told otherwise.
 *
 * A BOUND RATHER THAN A LIMIT ON THE DOCUMENT. At 5 to 15 seconds a page, 40
 * pages is five to ten minutes, which is a job somebody can watch finish. A
 * 214-page manual is read to page 40 and the index says it was truncated —
 * which is the same thing the text-layer path already says about a document
 * longer than one index entry may carry, and for the same reason: a partial
 * index that admits it is partial is more use than no index.
 */
export const OCR_DEFAULT_MAX_PAGES = 40;

/** Resolution to rasterise at. 300 dpi is what OCR engines are trained for. */
const RASTER_DPI = 300;

/**
 * EVERY RESOURCE LIMIT, IN ONE PLACE, AND WHY EACH ONE IS THE NUMBER IT IS.
 *
 * This runs as a command-line worker on the same small VPS that serves the
 * application, so an unbounded run is not merely slow — it is the web server
 * becoming unresponsive, or the disk filling with page images. Each bound below
 * is a thing that would otherwise be unbounded:
 *
 *   - PER-PROCESS TIMEOUTS bound ONE call. They were here already.
 *   - THE WHOLE-DOCUMENT DEADLINE is new, and it is the one that mattered:
 *     forty pages at a ten-minute page timeout is six and a half HOURS for a
 *     single job. Pages are read until the deadline and the index then says it
 *     is truncated — the same thing it already says about a page bound.
 *   - THE INPUT SIZE bounds what is written to the workspace, and therefore
 *     what `pdftoppm` can turn into PNGs. A 25 MB scan at 300 dpi is hundreds
 *     of megabytes of images.
 *   - THE TEXT BUDGET bounds what comes back. A badly-scanned page can produce
 *     a megabyte of noise per page, and the index is a database column.
 *
 * Every one is overridable from the environment, because the right number
 * depends on the machine — and every one is REPORTED when it bites, because a
 * limit that silently truncates is indistinguishable from a bad scan.
 */
const RASTERISE_TIMEOUT_MS = 5 * 60 * 1000;
const RECOGNISE_TIMEOUT_MS = 10 * 60 * 1000;
/** Twenty minutes for one document, whatever its page count. */
export const OCR_DEFAULT_DEADLINE_MS = 20 * 60 * 1000;
/** 40 MB: larger than the 25 MB upload limit, so it bounds nothing legitimate. */
export const OCR_DEFAULT_MAX_INPUT_BYTES = 40 * 1024 * 1024;
/** 2 MB of recognised text. A 40-page manual is nearer 100 kB. */
export const OCR_DEFAULT_MAX_TEXT_BYTES = 2 * 1024 * 1024;

const binaryVersion = (binary: string, argument: string): string | null => {
  const result = spawnSync(binary, [argument], { encoding: 'utf8', timeout: 15_000 });
  if (result.error !== undefined) return null;
  // `pdftoppm -v` writes its version to stderr and exits non-zero on some
  // builds, so the output rather than the status is what is read.
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return output.length === 0 ? null : output.split('\n')[0]!.trim();
};

/**
 * `pdftoppm` + `tesseract`, as local processes. NOTHING LEAVES THE MACHINE.
 *
 * Tesseract takes images, not PDFs, so the page has to be rasterised first;
 * `pdftoppm` from poppler-utils is what does that, and it is already installed
 * on most Linux images. The intermediate PNGs go to a temporary directory that
 * is removed in a `finally` — a customer's drawing must not be left as a loose
 * file for somebody to find.
 */
export interface LocalOcrConfig {
  /** Path to `pdftoppm`, or the bare name to find it on PATH. */
  readonly rasteriser?: string;
  /** Path to `tesseract`, or the bare name. */
  readonly recogniser?: string;
  /** Tesseract language data to use, e.g. `eng` or `eng+afr`. */
  readonly language?: string;
  readonly maxPages?: number;
  /** The whole-document deadline. See the limits above. */
  readonly deadlineMs?: number;
  readonly maxInputBytes?: number;
  readonly maxTextBytes?: number;
}

export const localOcr = (config: LocalOcrConfig = {}): OcrService => {
  const rasteriser = config.rasteriser ?? 'pdftoppm';
  const recogniser = config.recogniser ?? 'tesseract';
  const language = config.language ?? 'eng';
  const deadlineMs = config.deadlineMs ?? OCR_DEFAULT_DEADLINE_MS;
  const maxInputBytes = config.maxInputBytes ?? OCR_DEFAULT_MAX_INPUT_BYTES;
  const maxTextBytes = config.maxTextBytes ?? OCR_DEFAULT_MAX_TEXT_BYTES;

  const describe = (): OcrCapability => {
    const recogniserVersion = binaryVersion(recogniser, '--version');
    const rasteriserVersion = binaryVersion(rasteriser, '-v');

    const missing = [
      ...(recogniserVersion === null ? [`${recogniser} (package tesseract-ocr)`] : []),
      ...(rasteriserVersion === null ? [`${rasteriser} (package poppler-utils)`] : []),
    ];
    if (missing.length > 0) {
      return {
        available: false,
        engine: 'none',
        reason:
          `Text recognition needs ${missing.join(' and ')}, which is not installed on this ` +
          'server. See docs/library-ocr.md.',
      };
    }
    return { available: true, engine: recogniserVersion ?? recogniser, reason: '' };
  };

  return {
    describe,
    read: (pdf, options) => {
      const capability = describe();
      if (!capability.available) {
        return Promise.resolve({ kind: 'unavailable', reason: capability.reason });
      }

      const maxPages = options?.maxPages ?? config.maxPages ?? OCR_DEFAULT_MAX_PAGES;

      /*
       * THE INPUT SIZE, CHECKED BEFORE ANYTHING IS WRITTEN. A scan larger than
       * this would be turned into hundreds of megabytes of page images on a
       * VPS that also serves the application, so it is refused as a document
       * this machine cannot read rather than attempted and abandoned halfway.
       */
      if (pdf.byteLength > maxInputBytes) {
        return Promise.resolve({
          kind: 'empty',
          engine: describe().engine,
          reason:
            `The file is ${megabytes(pdf.byteLength)} MB, and this server reads up to ` +
            `${megabytes(maxInputBytes)} MB at a time — rasterising a larger one would fill the ` +
            'disk. Split it, or raise EJE_OCR_MAX_INPUT_MB on a machine with room.',
        });
      }

      const startedAt = Date.now();
      const workspace = mkdtempSync(join(tmpdir(), 'eje-ocr-'));
      try {
        const source = join(workspace, 'document.pdf');
        writeFileSync(source, pdf, { mode: 0o600 });

        const rastered = spawnSync(
          rasteriser,
          ['-png', '-r', String(RASTER_DPI), '-f', '1', '-l', String(maxPages), source, join(workspace, 'page')],
          { timeout: RASTERISE_TIMEOUT_MS, encoding: 'utf8' },
        );
        if (rastered.error !== undefined || rastered.status !== 0) {
          return Promise.resolve({
            kind: 'empty',
            engine: capability.engine,
            reason:
              'The pages could not be turned into images, so there was nothing to recognise. ' +
              'The file may be encrypted or damaged.',
          });
        }

        const pages = readdirSync(workspace)
          .filter((name) => name.startsWith('page') && name.endsWith('.png'))
          .sort();
        if (pages.length === 0) {
          return Promise.resolve({
            kind: 'empty',
            engine: capability.engine,
            reason: 'No pages came out of the file, so there was nothing to recognise.',
          });
        }

        const texts: string[] = [];
        let bytesSoFar = 0;
        let pagesRead = 0;
        let pagesFailed = 0;
        let truncationReason = '';

        for (const page of pages) {
          /*
           * THE WHOLE-DOCUMENT DEADLINE, CHECKED BETWEEN PAGES. The per-page
           * timeout bounds one call; this bounds the job. Forty pages at a
           * ten-minute page timeout is six and a half hours, which on this
           * machine is the web server starved for an afternoon.
           */
          if (Date.now() - startedAt > deadlineMs) {
            truncationReason =
              `Recognition stopped after ${Math.round(deadlineMs / 60_000)} minutes, having read ` +
              `${pagesRead} of ${pages.length} page(s). Raise EJE_OCR_DEADLINE_MINUTES to read more.`;
            break;
          }

          const output = join(workspace, `${page}.out`);
          const recognised = spawnSync(
            recogniser,
            [join(workspace, page), output, '-l', language],
            { timeout: RECOGNISE_TIMEOUT_MS, encoding: 'utf8' },
          );

          /*
           * MISSING LANGUAGE DATA IS A CONFIGURATION PROBLEM, NOT A BAD SCAN.
           *
           * Tesseract exits non-zero with "Error opening data file" when the
           * trained data for the language is not installed — and every page
           * fails the same way, so the document came back as "no text came out
           * of any of them", which blames the customer's scan for an apt-get
           * nobody ran. It is reported as UNAVAILABLE, naming the language, so
           * the job is retried after somebody installs it rather than being
           * recorded as an unreadable document.
           */
          const said = `${recognised.stdout ?? ''}${recognised.stderr ?? ''}`;
          if (/Error opening data file|Failed loading language|tessdata/iu.test(said)) {
            return Promise.resolve({
              kind: 'unavailable',
              reason:
                `The "${language}" language data is not installed for ${recogniser}, so nothing ` +
                'could be recognised. Install the tesseract language package (for English, ' +
                '`tesseract-ocr-eng`) or set EJE_OCR_LANGUAGE to one that is installed.',
            });
          }

          /*
           * A PAGE THAT FAILS DOES NOT FAIL THE DOCUMENT. One unreadable page
           * in a forty-page manual should not throw away the other
           * thirty-nine; the text-layer path takes the same view of a stream it
           * cannot decompress. COUNTED, though — a document where half the
           * pages failed is a document somebody should look at, and silence
           * about it reads as a clean read.
           */
          if (recognised.error !== undefined || recognised.status !== 0) {
            pagesFailed += 1;
            continue;
          }

          let pageText: string;
          try {
            pageText = readFileSync(`${output}.txt`, 'utf8');
          } catch {
            // Nothing was written for this page. Same reasoning as above.
            pagesFailed += 1;
            continue;
          }

          /*
           * THE TEXT BUDGET. A badly-scanned page can produce a megabyte of
           * noise, and what comes out of here goes into a database column and
           * a search index. Stopping at the budget and SAYING SO beats
           * either a refusal or a column nobody sized for it.
           */
          if (bytesSoFar + Buffer.byteLength(pageText, 'utf8') > maxTextBytes) {
            truncationReason =
              `Recognition stopped at ${megabytes(maxTextBytes)} MB of text, having read ` +
              `${pagesRead} of ${pages.length} page(s). A scan producing this much text is ` +
              'usually a poor scan rather than a long document.';
            break;
          }

          bytesSoFar += Buffer.byteLength(pageText, 'utf8');
          pagesRead += 1;
          texts.push(pageText);
        }

        const text = texts.join('\n').trim();
        if (text.length === 0) {
          return Promise.resolve({
            kind: 'empty',
            engine: capability.engine,
            reason:
              `${pages.length} page(s) were rasterised and no text came out of any of them` +
              `${pagesFailed > 0 ? ` (${pagesFailed} failed to be recognised)` : ''}. The scan ` +
              'may be blank, too faint, or not of a document.',
          });
        }
        return Promise.resolve({
          kind: 'text',
          text,
          pages: pagesRead,
          engine: capability.engine,
          /*
           * TRUNCATED BY A LIMIT, OR BY THE PAGE BOUND. Both are this engine
           * stopping before the document ended, which is what the index has to
           * be able to say — see `OcrOutcome`.
           */
          truncated: truncationReason.length > 0 || pages.length >= maxPages,
          truncationReason:
            truncationReason.length > 0
              ? truncationReason
              : pages.length >= maxPages
                ? `Only the first ${maxPages} page(s) were read. Raise EJE_OCR_MAX_PAGES to read more.`
                : '',
          pagesFailed,
        });
      } catch (cause) {
        /*
         * A FAILURE OF THIS MACHINE, not of the document — a full disk, a
         * directory that cannot be made. It is reported as `unavailable` so
         * the job is retried rather than marked as an unreadable document.
         */
        return Promise.resolve({
          kind: 'unavailable',
          reason: `Text recognition could not run: ${cause instanceof Error ? cause.message : 'unknown error'}.`,
        });
      } finally {
        // A customer's drawing must not be left as a loose file on the server.
        rmSync(workspace, { recursive: true, force: true });
      }
    },
  };
};

/**
 * WHAT THIS DEPLOYMENT WILL ACTUALLY DO, read from its own environment.
 *
 * For `npm run library:ocr --report`, so an operator wondering why a 214-page
 * manual came back as forty pages can see the answer without reading the
 * source — and so somebody who set `EJE_OCR_MAX_PAGES=lots` can see that it
 * fell back to the default rather than silently doing nothing.
 *
 * `overridden` names the variables that are SET, not the values: a list of
 * values would be a configuration dump, and this is printed to a terminal that
 * may be logged.
 */
export interface OcrLimitSummary {
  readonly maxPages: number;
  readonly deadlineMinutes: number;
  readonly maxInputMb: number;
  readonly maxTextMb: number;
  readonly language: string;
  readonly rasteriser: string;
  readonly recogniser: string;
  /** Which of the variables below the deployment has set. */
  readonly overridden: readonly string[];
}

const OCR_VARIABLES = [
  'EJE_OCR',
  'EJE_OCR_TESSERACT',
  'EJE_OCR_PDFTOPPM',
  'EJE_OCR_LANGUAGE',
  'EJE_OCR_MAX_PAGES',
  'EJE_OCR_DEADLINE_MINUTES',
  'EJE_OCR_MAX_INPUT_MB',
  'EJE_OCR_MAX_TEXT_MB',
] as const;

export const describeOcrLimits = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): OcrLimitSummary => {
  const positive = (value: string | undefined, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };

  return {
    maxPages: Math.max(1, positive(env.EJE_OCR_MAX_PAGES, OCR_DEFAULT_MAX_PAGES)),
    deadlineMinutes: positive(env.EJE_OCR_DEADLINE_MINUTES, OCR_DEFAULT_DEADLINE_MS / 60_000),
    maxInputMb: positive(env.EJE_OCR_MAX_INPUT_MB, OCR_DEFAULT_MAX_INPUT_BYTES / (1024 * 1024)),
    maxTextMb: positive(env.EJE_OCR_MAX_TEXT_MB, OCR_DEFAULT_MAX_TEXT_BYTES / (1024 * 1024)),
    language: env.EJE_OCR_LANGUAGE ?? 'eng',
    rasteriser: env.EJE_OCR_PDFTOPPM ?? 'pdftoppm',
    recogniser: env.EJE_OCR_TESSERACT ?? 'tesseract',
    overridden: OCR_VARIABLES.filter((name) => (env[name] ?? '').trim().length > 0),
  };
};

/**
 * Which engine a deployment gets, from its own configuration.
 *
 * UNAVAILABLE UNLESS ASKED FOR. `EJE_OCR=local` is a deployment saying it has
 * installed the binaries and wants them used; anything else — unset, a typo, a
 * value from a future version — gets the honest adapter that recognises
 * nothing. A missing engine must never be a surprise, and a misspelt
 * configuration value must never silently turn a feature off that somebody
 * believes is on, so the unset case and the misspelt case say different things.
 */
export const buildOcr = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): OcrService => {
  const configured = (env.EJE_OCR ?? '').trim().toLowerCase();
  if (configured === 'local') {
    /*
     * EVERY DEPENDENCY AND EVERY LIMIT, CONFIGURABLE FROM THE ENVIRONMENT.
     *
     * The BINARY PATHS matter as much as the limits: `tesseract` and
     * `pdftoppm` are on PATH on a Debian image and somewhere else entirely in
     * a container, on NixOS, or where an operator has built a newer tesseract
     * into /opt. Hard-coding the bare names made the engine unusable on any of
     * those for no reason — and "not installed" would have been the message,
     * which is wrong and sends somebody to apt-get for a binary they have.
     *
     * A bad number falls back to the default rather than to zero or NaN: an
     * unreadable `EJE_OCR_MAX_PAGES=lots` must not mean "read no pages".
     */
    const positive = (value: string | undefined, fallback: number): number => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    };

    return localOcr({
      ...(env.EJE_OCR_TESSERACT === undefined ? {} : { recogniser: env.EJE_OCR_TESSERACT }),
      ...(env.EJE_OCR_PDFTOPPM === undefined ? {} : { rasteriser: env.EJE_OCR_PDFTOPPM }),
      ...(env.EJE_OCR_LANGUAGE === undefined ? {} : { language: env.EJE_OCR_LANGUAGE }),
      ...(env.EJE_OCR_MAX_PAGES === undefined
        ? {}
        : { maxPages: Math.max(1, positive(env.EJE_OCR_MAX_PAGES, OCR_DEFAULT_MAX_PAGES)) }),
      ...(env.EJE_OCR_DEADLINE_MINUTES === undefined
        ? {}
        : {
            deadlineMs:
              positive(env.EJE_OCR_DEADLINE_MINUTES, OCR_DEFAULT_DEADLINE_MS / 60_000) * 60_000,
          }),
      ...(env.EJE_OCR_MAX_INPUT_MB === undefined
        ? {}
        : {
            maxInputBytes:
              positive(env.EJE_OCR_MAX_INPUT_MB, OCR_DEFAULT_MAX_INPUT_BYTES / (1024 * 1024)) *
              1024 *
              1024,
          }),
      ...(env.EJE_OCR_MAX_TEXT_MB === undefined
        ? {}
        : {
            maxTextBytes:
              positive(env.EJE_OCR_MAX_TEXT_MB, OCR_DEFAULT_MAX_TEXT_BYTES / (1024 * 1024)) *
              1024 *
              1024,
          }),
    });
  }
  if (configured.length > 0) {
    return unavailableOcr(
      `EJE_OCR is set to "${configured}", which is not an engine this build knows. ` +
        'The only value is `local`. Nothing has been recognised, and nothing has been sent ' +
        'anywhere — see docs/library-ocr.md.',
    );
  }
  return unavailableOcr();
};
