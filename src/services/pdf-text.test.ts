import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractPdfText, MAX_INDEXED_CHARACTERS } from '@/lib/pdf/extract-text';
import { buildPdfText, builtinPdfText, popplerPdfText } from './pdf-text';

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
const CID_MANUAL = readFileSync('src/services/__fixtures__/cid-manual.pdf');
const SCAN = readFileSync('src/services/__fixtures__/scan-three-pages.pdf');

const bytesOf = (file: Buffer): Uint8Array => new Uint8Array(file);

describe('PDF text extraction', () => {
  describe('a manual encoded the way real manuals are', () => {
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

    it('is CUT at the index budget, and says so rather than hiding it', () => {
      const reading = popplerPdfText().read(bytesOf(LONG));
      expect(reading.kind).toBe('text');
      if (reading.kind !== 'text') throw new Error('unreachable');

      /*
       * THE LIMIT THAT NOW BITES. `MAX_INDEXED_CHARACTERS` was sized when the
       * byte reader was the only engine and most real manuals came out
       * unreadable. Now that they come out whole, an ordinary 214-page manual
       * exceeds it at about page 96 — so 118 pages are not searchable, the
       * index says `truncated`, and the library says "Searchable — 96 of 214
       * pages". Nobody is misled, and somebody searching for an alarm on page
       * 150 still finds nothing: see docs/library-ocr.md §0 for the
       * measurement and the recommendation.
       */
      expect(reading.truncated).toBe(true);
      expect(reading.pages.length).toBeLessThan(reading.totalPages);
      expect(reading.pages.length).toBeGreaterThan(50);
      expect(reading.text.length).toBeLessThanOrEqual(MAX_INDEXED_CHARACTERS + 1_000);
      // The pages that ARE indexed are the first ones, in order, so a
      // technician reading the caveat knows which part of the book it covers.
      expect(reading.pages[0]?.pageNumber).toBe(1);
      expect(reading.pages[reading.pages.length - 1]?.pageNumber).toBe(reading.pages.length);
    });
  });

  describe('a document that really is a scan', () => {
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
    it('reports a file that is not a PDF as failed, not as a scan', () => {
      const reading = popplerPdfText().read(new TextEncoder().encode('this is not a PDF at all'));
      expect(reading.kind).toBe('failed');
      if (reading.kind !== 'failed') throw new Error('unreachable');
      expect(reading.reason.length).toBeGreaterThan(0);
    });

    it('refuses a file beyond the input bound before reading it', () => {
      const reading = popplerPdfText({ maxInputBytes: 16 }).read(bytesOf(CID_MANUAL));
      expect(reading.kind).toBe('failed');
      if (reading.kind !== 'failed') throw new Error('unreachable');
      expect(reading.reason).toMatch(/MB of PDF at a time/u);
    });

    it('says it was CUT rather than quietly indexing part of a manual', () => {
      const reading = popplerPdfText({ maxCharacters: 30 }).read(bytesOf(CID_MANUAL));
      expect(reading.kind).toBe('text');
      if (reading.kind !== 'text') throw new Error('unreachable');
      expect(reading.truncated).toBe(true);
      expect(reading.text.length).toBeLessThanOrEqual(30);
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
