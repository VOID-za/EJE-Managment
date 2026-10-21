import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  | { readonly kind: 'text'; readonly text: string; readonly pages: number; readonly engine: string }
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

/** Both binaries, and how long each is given. */
const RASTERISE_TIMEOUT_MS = 5 * 60 * 1000;
const RECOGNISE_TIMEOUT_MS = 10 * 60 * 1000;

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
export const localOcr = (
  config: {
    readonly rasteriser?: string;
    readonly recogniser?: string;
    readonly language?: string;
    readonly maxPages?: number;
  } = {},
): OcrService => {
  const rasteriser = config.rasteriser ?? 'pdftoppm';
  const recogniser = config.recogniser ?? 'tesseract';
  const language = config.language ?? 'eng';

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
        for (const page of pages) {
          const output = join(workspace, `${page}.out`);
          const recognised = spawnSync(
            recogniser,
            [join(workspace, page), output, '-l', language],
            { timeout: RECOGNISE_TIMEOUT_MS, encoding: 'utf8' },
          );
          /*
           * A PAGE THAT FAILS DOES NOT FAIL THE DOCUMENT. One unreadable page
           * in a forty-page manual should not throw away the other
           * thirty-nine; the text-layer path takes the same view of a stream it
           * cannot decompress, and records how many.
           */
          if (recognised.error !== undefined || recognised.status !== 0) continue;
          try {
            texts.push(readFileSync(`${output}.txt`, 'utf8'));
          } catch {
            // Nothing was written for this page. Same reasoning as above.
          }
        }

        const text = texts.join('\n').trim();
        if (text.length === 0) {
          return Promise.resolve({
            kind: 'empty',
            engine: capability.engine,
            reason:
              `${pages.length} page(s) were read and no text came out of any of them. The scan ` +
              'may be blank, too faint, or not of a document.',
          });
        }
        return Promise.resolve({ kind: 'text', text, pages: pages.length, engine: capability.engine });
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
    return localOcr({
      ...(env.EJE_OCR_LANGUAGE === undefined ? {} : { language: env.EJE_OCR_LANGUAGE }),
      ...(env.EJE_OCR_MAX_PAGES === undefined
        ? {}
        : { maxPages: Math.max(1, Number(env.EJE_OCR_MAX_PAGES) || OCR_DEFAULT_MAX_PAGES) }),
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
