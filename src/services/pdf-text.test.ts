import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { extractPdfText, MAX_INDEXED_CHARACTERS } from '@/lib/pdf/extract-text';
import { buildPdfText, builtinPdfText, popplerPdfText } from './pdf-text';
import { buildManual } from '@/test/pdf-manual';

/**
 * ORDINARY PDF TEXT EXTRACTION, WHICH IS THE LIBRARY'S PRIMARY PATH.
 * LIB-TEXT-1.
 *
 * The one case that matters most is the FIRST test below: a PDF encoded the way
 * a manufacturer's manual is encoded — a subset Type0 font, Identity-H, glyph
 * ids in the content stream and a /ToUnicode map — which the built-in reader
 * honestly cannot read and reports as a scan. If that document goes to
 * recognition, a 214-page manual becomes an 83-minute job (BD-21's measurement)
 * that stops at page 40, and the library tells a technician EJE has nothing on
 * that machine.
 *
 * The built-in reader's own behaviour is asserted here too, not to mock it but
 * because it is the fallback for a deployment with no poppler, and the contrast
 * is the evidence.
 */
/**
 * POPPLER IS REQUIRED FOR THIS FILE, and the failure says so in one line.
 *
 * `pdftotext` is the library's PRIMARY engine, so these tests must exercise the
 * real one rather than skipping to the fallback — a suite that quietly tests the
 * byte reader instead would report the primary search path as covered when it is
 * not. It is NOT on the GitHub runner image (CI installs it explicitly, which is
 * how this was found: six cryptic assertion failures that all meant one missing
 * package).
 *
 * So the absence is reported ONCE, naming the package, instead of as six
 * mismatched expectations.
 */
const requirePoppler = (): void => {
  const capability = popplerPdfText().describe();
  if (capability.perPage) return;
  throw new Error(
    'These tests need `pdftotext` (package poppler-utils), which is not installed on this ' +
      'machine: `sudo apt-get install -y poppler-utils`. It is the library\u2019s primary text ' +
      `engine \u2014 see docs/library-ocr.md §0. The engine reported: ${capability.reason}`,
  );
};

const CID_MANUAL = readFileSync('src/services/__fixtures__/cid-manual.pdf');
const SCAN = readFileSync('src/services/__fixtures__/scan-three-pages.pdf');

const bytesOf = (file: Buffer): Uint8Array => new Uint8Array(file);

describe('PDF text extraction', () => {
  describe('a manual encoded the way real manuals are', () => {
    beforeAll(requirePoppler);
    it('is NOT readable by the built-in reader, which is the defect', () => {
      /*
       * THE MEASUREMENT THIS WHOLE CHANGE RESTS ON. Not a hypothetical: the
       * byte reader states in its own documentation that it cannot map a CID
       * font, and this is that statement as a failing document.
       */
      const outcome = extractPdfText(bytesOf(CID_MANUAL));
      expect(outcome.kind).toBe('needs_ocr');
      if (outcome.kind !== 'needs_ocr') throw new Error('unreachable');
      expect(outcome.reason).toMatch(/not readable text|no usable encoding/u);
    });

    it('IS read by poppler, page by page, with page 3 named as the only scan', () => {
      const reading = popplerPdfText().read(bytesOf(CID_MANUAL));
      expect(reading.kind, JSON.stringify(reading)).toBe('text');
      if (reading.kind !== 'text') throw new Error('unreachable');

      // The sentence a technician would search for, out of the glyph ids.
      expect(reading.text).toContain('ALARM 414 HYDRAULIC PRESSURE LOW');
      expect(reading.text).toContain('TORQUE SETTINGS MAST BOLTS 210 NEWTON METRES');

      // PER PAGE, which is what lets a result say where to look.
      expect(reading.totalPages).toBe(4);
      expect(reading.pages.map((page) => page.pageNumber)).toEqual([1, 2, 4]);
      expect(reading.pages[0]?.text).toContain('ALARM 414');
      expect(reading.pages[1]?.text).toContain('ALARM 415');

      /*
       * AND THE ONE PAGE THAT IS A PICTURE IS THE ONLY RECOGNITION CANDIDATE.
       * Three pages are searchable now; one page is 25 seconds of work rather
       * than the whole book being 83 minutes of it.
       */
      expect(reading.pagesWithoutText).toEqual([3]);
      expect(reading.truncated).toBe(false);
      expect(reading.engine).toMatch(/pdftotext/iu);
    });
  });

  describe('a manual the length of a real one', () => {
    beforeAll(requirePoppler);
    /*
     * THE TWO FACTS ONLY A LONG DOCUMENT ESTABLISHES, both of which
     * `docs/library-ocr.md` §0 records with the numbers.
     */
    const LONG = readFileSync('src/services/__fixtures__/long-manual.pdf');

    it('is read in well under a second, which is why it happens in the request', () => {
      const started = Date.now();
      const reading = popplerPdfText().read(bytesOf(LONG));
      const elapsed = Date.now() - started;

      expect(reading.kind).toBe('text');
      if (reading.kind !== 'text') throw new Error('unreachable');
      expect(reading.totalPages).toBe(214);
      expect(reading.pagesWithoutText).toEqual([]);

      /*
       * Measured at about 210 ms on the development container. The assertion
       * is generous — five seconds — because it is a CI machine's clock and
       * the point is the ORDER OF MAGNITUDE: the same document through
       * recognition is 83 to 89 minutes (BD-21), which is why extraction
       * happens inside the upload request and recognition cannot.
       */
      expect(elapsed).toBeLessThan(5_000);
    });

    it('is read ALL THE WAY THROUGH — every page, not the first 96 (#70)', () => {
      const reading = popplerPdfText().read(bytesOf(LONG));
      expect(reading.kind).toBe('text');
      if (reading.kind !== 'text') throw new Error('unreachable');

      /*
       * THE LIMIT THAT USED TO BITE. `MAX_INDEXED_CHARACTERS` — 400 000 for the
       * whole document — stopped this ordinary 214-page manual at page 96, so a
       * search for an alarm on page 150 found nothing. The pages are now the
       * index, so every one of them is read and kept.
       */
      expect(reading.complete).toBe(true);
      expect(reading.truncated).toBe(false);
      expect(reading.limits).toEqual([]);
      expect(reading.pages).toHaveLength(214);
      expect(reading.pages.map((page) => page.pageNumber)).toEqual(
        Array.from({ length: 214 }, (_unused, offset) => offset + 1),
      );
      expect(reading.pages[149]?.text.length).toBeGreaterThan(1_000);
      // The document-level summary is still bounded — it is one tsvector — and
      // is no longer what decides whether page 150 can be found.
      expect(reading.text.length).toBeLessThanOrEqual(MAX_INDEXED_CHARACTERS);
    });
  });

  describe('documents far longer than the fixture, read in batches (#70)', () => {
    beforeAll(requirePoppler);
    const NO_PDFINFO = '/nonexistent/pdfinfo';

    it('reads a document whose length is an EXACT multiple of the batch, with no page count', () => {
      /*
       * The hard boundary: 400 pages in batches of 200, and `pdfinfo` absent, so
       * the end is only found by asking for page 401. Poppler refuses that
       * range ("Wrong page range"); xpdf answers with nothing. Both must read as
       * the end of the book — not as a damaged file, and not as a partial one.
       */
      const reading = popplerPdfText({
        pdfinfoBinary: NO_PDFINFO,
        limits: { batchPages: 200 },
      }).read(buildManual({ pages: 400 }));
      expect(reading.kind).toBe('text');
      if (reading.kind !== 'text') throw new Error('unreachable');
      expect(reading.complete).toBe(true);
      expect(reading.totalPages).toBe(400);
      expect(reading.totalPagesKnown).toBe(true);
      expect(reading.pages).toHaveLength(400);
      expect(reading.limits).toEqual([]);
    });

    it('says the total is UNKNOWN, rather than guessing, when it stops early with no page count', () => {
      const reading = popplerPdfText({
        pdfinfoBinary: NO_PDFINFO,
        limits: { maxPages: 250, batchPages: 100 },
      }).read(buildManual({ pages: 600 }));
      expect(reading.kind).toBe('text');
      if (reading.kind !== 'text') throw new Error('unreachable');
      expect(reading.complete).toBe(false);
      expect(reading.pages).toHaveLength(250);
      // At least one more page exists — the one it stopped before — and no more
      // is claimed than that.
      expect(reading.totalPagesKnown).toBe(false);
      expect(reading.totalPages).toBe(251);
      expect(reading.limits.map((hit) => hit.kind)).toEqual(['pages', 'pages']);
      expect(reading.limits[1]?.message).toMatch(/pdfinfo/u);
    });

    it('a stopped reading keeps text pages it read, and names only the blank ones it read', () => {
      const reading = popplerPdfText({ limits: { maxPages: 100, batchPages: 50 } }).read(
        buildManual({ pages: 300, blankPages: [10, 250] }),
      );
      expect(reading.kind).toBe('text');
      if (reading.kind !== 'text') throw new Error('unreachable');
      // Page 250 was never examined, so it is NOT reported as a picture.
      expect(reading.pagesWithoutText).toEqual([10]);
      expect(reading.pages).toHaveLength(99);
      expect(reading.complete).toBe(false);
    });
  });

  describe('a document that really is a scan', () => {
    beforeAll(requirePoppler);
    it('is reported as needing recognition, with every page named', () => {
      const reading = popplerPdfText().read(bytesOf(SCAN));
      expect(reading.kind).toBe('needs_ocr');
      if (reading.kind !== 'needs_ocr') throw new Error('unreachable');
      expect(reading.totalPages).toBe(3);
      expect(reading.pagesWithoutText).toEqual([1, 2, 3]);
      expect(reading.reason).toMatch(/scan/u);
    });
  });

  describe('what it refuses, and how it says so', () => {
    beforeAll(requirePoppler);
    it('reports a file that is not a PDF as failed, not as a scan', () => {
      const reading = popplerPdfText().read(new TextEncoder().encode('this is not a PDF at all'));
      expect(reading.kind).toBe('failed');
      if (reading.kind !== 'failed') throw new Error('unreachable');
      expect(reading.reason.length).toBeGreaterThan(0);
    });

    it('refuses a file beyond the input bound before reading it', () => {
      const reading = popplerPdfText({ limits: { maxInputBytes: 16 } }).read(bytesOf(CID_MANUAL));
      expect(reading.kind).toBe('failed');
      if (reading.kind !== 'failed') throw new Error('unreachable');
      expect(reading.reason).toMatch(/MB of PDF at a time/u);
    });

    it('says a PAGE was cut rather than quietly indexing part of it', () => {
      const reading = popplerPdfText({ limits: { maxPageCharacters: 30 } }).read(
        bytesOf(CID_MANUAL),
      );
      expect(reading.kind).toBe('text');
      if (reading.kind !== 'text') throw new Error('unreachable');
      expect(reading.truncated).toBe(true);
      // The reading still went through every page; only the long ones were cut.
      expect(reading.complete).toBe(true);
      expect(reading.pages.every((page) => page.text.length <= 30)).toBe(true);
      expect(reading.pages.some((page) => page.truncated === true)).toBe(true);
      expect(reading.limits.map((hit) => hit.kind)).toEqual(['page_characters']);
    });

    it('falls back to the byte reader when the binary is not there, and says why', () => {
      const service = popplerPdfText({ binary: '/nonexistent/pdftotext' });
      const capability = service.describe();
      expect(capability.engine).toBe('none');
      expect(capability.perPage).toBe(false);
      expect(capability.reason).toMatch(/poppler-utils/u);

      // A deployment without poppler still indexes what the reader can read,
      // rather than refusing every upload.
      const reading = service.read(bytesOf(CID_MANUAL));
      expect(reading.kind).toBe('needs_ocr');
      expect(reading.engine).toBe('built-in PDF reader');
    });
  });

  describe('the built-in reader, as the fallback', () => {
    it('reports a page count and NO page detail, rather than guessing', () => {
      const reading = builtinPdfText().read(bytesOf(SCAN));
      expect(reading.kind).toBe('needs_ocr');
      if (reading.kind !== 'needs_ocr') throw new Error('unreachable');
      /*
       * An empty candidate list is the honest answer: this engine does not
       * know which pages have text. Naming every page would send a 214-page
       * manual to recognition for no reason.
       */
      expect(reading.pagesWithoutText).toEqual([]);
      expect(builtinPdfText().describe().perPage).toBe(false);
    });
  });

  describe('which engine a deployment gets', () => {
    beforeAll(requirePoppler);
    it('is poppler by default, with no configuration at all', () => {
      expect(buildPdfText({}).describe().engine).toMatch(/pdftotext/iu);
    });

    it('is the byte reader when asked for, and says it was asked for', () => {
      const capability = buildPdfText({ EJE_PDF_TEXT: 'builtin' }).describe();
      expect(capability.engine).toBe('built-in PDF reader');
      expect(capability.reason).toMatch(/asked for by configuration/u);
    });

    it('names a misspelt setting rather than silently changing engine', () => {
      /*
       * The same rule `buildOcr` follows: an unset value and a misspelt one
       * must say different things, or a setting somebody believes is on turns a
       * feature off in silence.
       */
      const capability = buildPdfText({ EJE_PDF_TEXT: 'popler' }).describe();
      expect(capability.engine).toBe('built-in PDF reader');
      expect(capability.reason).toMatch(/"popler", which is not an engine/u);
    });

    it('accepts `auto` and `poppler` as the same thing', () => {
      expect(buildPdfText({ EJE_PDF_TEXT: 'auto' }).describe().perPage).toBe(true);
      expect(buildPdfText({ EJE_PDF_TEXT: 'poppler' }).describe().perPage).toBe(true);
    });

    it('takes the binary path from the environment', () => {
      const capability = buildPdfText({ EJE_PDF_TEXT_BINARY: '/nonexistent/pdftotext' }).describe();
      expect(capability.engine).toBe('none');
      expect(capability.reason).toMatch(/\/nonexistent\/pdftotext/u);
    });
  });
});
