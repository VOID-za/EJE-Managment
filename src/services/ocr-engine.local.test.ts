import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildOcr, localOcr } from './ocr';

/**
 * THE REAL ENGINE, AGAINST A REAL SCAN. LIB-5.
 *
 * Everything else about OCR is tested against a stub, which is right: the queue,
 * the retry policy and the index are what the application owns. But a stub
 * cannot tell anybody whether `pdftoppm | tesseract` actually reads a page, and
 * "the architecture is built" is not the same claim as "it works".
 *
 * SKIPPED WHERE THE BINARIES ARE NOT INSTALLED, which is CI and every
 * deployment today. That is deliberate and it is not a hole: the engine's
 * behaviour WITHOUT them is tested unconditionally in `ocr.test.ts`, and this
 * file is what proves the other half on a machine that has them. A test that
 * silently passed by doing nothing would be worse than one that says it
 * skipped.
 *
 * THE FIXTURE HAS NO TEXT LAYER. It was built by rendering words to an IMAGE
 * and wrapping the image in a PDF, so `pdftotext` returns nothing from it — if
 * it had a text layer this test would pass without any recognition happening at
 * all, which is the one way it could lie.
 */
const engineInstalled = localOcr().describe().available;
const describeEngine = engineInstalled ? describe : describe.skip;

const SCAN = readFileSync(join(import.meta.dirname, '__fixtures__/scan-three-pages.pdf'));

describeEngine('pdftoppm and tesseract, on a scan with no text layer', () => {
  it('reads every page, and gets the words right', async () => {
    const outcome = await buildOcr({ EJE_OCR: 'local' }).read(SCAN);

    expect(outcome.kind).toBe('text');
    if (outcome.kind !== 'text') return;

    const text = outcome.text.replace(/\s+/gu, ' ').trim();
    // Three pages, each with its own alarm number, so a test that read only the
    // first page or concatenated the same page three times fails.
    expect(text).toContain('ALARM 411');
    expect(text).toContain('ALARM 412');
    expect(text).toContain('ALARM 413');
    expect(outcome.pages).toBe(3);
    expect(outcome.pagesFailed).toBe(0);
    expect(outcome.truncated).toBe(false);
    // The engine names itself, which the queue records against the job.
    expect(outcome.engine).toMatch(/tesseract/iu);
  });

  it('TRUNCATES at the page bound, and says which bound', async () => {
    const outcome = await buildOcr({ EJE_OCR: 'local', EJE_OCR_MAX_PAGES: '1' }).read(SCAN);

    expect(outcome.kind).toBe('text');
    if (outcome.kind !== 'text') return;

    expect(outcome.text).toContain('ALARM 411');
    expect(outcome.text).not.toContain('ALARM 412');
    expect(outcome.pages).toBe(1);
    expect(outcome.truncated).toBe(true);
    // The REASON, because an index marked truncated with no reason sends
    // somebody looking at the document instead of at the setting.
    expect(outcome.truncationReason).toMatch(/EJE_OCR_MAX_PAGES/u);
  });

  it('REFUSES a file past the input bound before writing it anywhere', async () => {
    const outcome = await buildOcr({ EJE_OCR: 'local', EJE_OCR_MAX_INPUT_MB: '0.001' }).read(SCAN);
    // 0.001 is not a whole MB, so it is used as given: the file is larger.
    expect(outcome.kind).toBe('empty');
    if (outcome.kind === 'empty') expect(outcome.reason).toMatch(/EJE_OCR_MAX_INPUT_MB/u);
  });

  it('reports MISSING LANGUAGE DATA as a configuration problem, not a bad scan', async () => {
    /*
     * THE DEFECT THIS EXISTS FOR. Tesseract exits non-zero for every page when
     * the trained data is absent, and the loop treated that like an unreadable
     * page — so the document came back as "no text came out of any of them",
     * which blames a customer's scan for an apt-get nobody ran. `unavailable`
     * means the job is RETRIED once somebody installs it, rather than being
     * recorded as an unreadable document for ever.
     */
    const outcome = await buildOcr({ EJE_OCR: 'local', EJE_OCR_LANGUAGE: 'zzz' }).read(SCAN);

    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.reason).toMatch(/"zzz"/u);
    expect(outcome.reason).toMatch(/language/iu);
    // And it names the package, because "OCR failed" sends somebody to the
    // document and this sends them to the right place.
    expect(outcome.reason).toMatch(/tesseract-ocr-eng/u);
  });

  it('leaves no workspace behind, even on the path that succeeded', async () => {
    const { readdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const before = readdirSync(tmpdir()).filter((name) => name.startsWith('eje-ocr-'));

    await buildOcr({ EJE_OCR: 'local', EJE_OCR_MAX_PAGES: '1' }).read(SCAN);

    // A customer's drawing must not be left as a loose file on the server.
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith('eje-ocr-'))).toEqual(before);
  });
});

describe('whether this machine has the engine', () => {
  it('says so either way, so a skipped suite above is visible', () => {
    // Not an assertion about the engine: an assertion that the DECISION to skip
    // was made from the real capability rather than from an environment
    // variable somebody set.
    expect(typeof engineInstalled).toBe('boolean');
    if (!engineInstalled) {
      expect(localOcr().describe().reason).toMatch(/not installed/u);
    }
  });
});
