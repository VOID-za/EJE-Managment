import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { buildOcr, localOcr, unavailableOcr } from './ocr';

/**
 * THE ENGINE, AND THE THREE WAYS A DEPLOYMENT CAN BE CONFIGURED.
 *
 * What matters here is not that OCR works — that needs an engine installed, and
 * `docs/library-ocr.md` says the decision to install one is EJE's. What matters
 * is that a deployment WITHOUT one behaves correctly and says what is missing,
 * because that is the state every deployment is in today, and a feature that
 * fails obscurely when it is switched off is worse than one that is absent.
 */

const PDF = new TextEncoder().encode('%PDF-1.4 a scan');

describe('a server with no recognition engine', () => {
  it('says so, and names what would be needed', () => {
    const capability = unavailableOcr().describe();

    expect(capability.available).toBe(false);
    // "OCR failed" sends somebody looking at the document. This sends them to
    // the right place.
    expect(capability.reason).toMatch(/tesseract-ocr/u);
    expect(capability.reason).toMatch(/poppler-utils/u);
    expect(capability.reason).toMatch(/docs\/library-ocr\.md/u);
  });

  it('recognises nothing, and does not pretend to', async () => {
    const outcome = await unavailableOcr().read(PDF);
    expect(outcome.kind).toBe('unavailable');
  });
});

describe('which engine a deployment gets', () => {
  it('gets none when nothing is configured, which is every deployment today', () => {
    const engine = buildOcr({});
    expect(engine.describe().available).toBe(false);
    expect(engine.describe().engine).toBe('none');
  });

  it('gets none for a value this build does not know, AND SAYS WHICH VALUE', async () => {
    /*
     * A MISSPELT CONFIGURATION MUST NOT LOOK LIKE AN ABSENT ONE. Somebody who
     * wrote `EJE_OCR=tesseract` believes OCR is on; telling them "nothing is
     * configured" sends them to configure it again the same way.
     */
    const engine = buildOcr({ EJE_OCR: 'tesserakt' });
    expect(engine.describe().reason).toMatch(/"tesserakt"/u);
    expect(engine.describe().reason).toMatch(/only value is/u);
    // And nothing was sent anywhere, which the message also says.
    expect(engine.describe().reason).toMatch(/nothing has been sent anywhere/u);
    expect((await engine.read(PDF)).kind).toBe('unavailable');
  });

  it('asks for the local engine when told to', () => {
    // On a machine with no tesseract this still reports unavailable — the
    // point is which adapter was chosen, and that it reports honestly.
    const engine = buildOcr({ EJE_OCR: 'local' });
    const capability = engine.describe();
    if (capability.available) {
      expect(capability.engine.length).toBeGreaterThan(0);
    } else {
      expect(capability.reason).toMatch(/not installed on this server/u);
    }
  });
});

describe('the local engine', () => {
  it('reports itself unavailable, by name, when a binary is missing', () => {
    const engine = localOcr({ recogniser: '/nonexistent/tesseract' });
    const capability = engine.describe();

    expect(capability.available).toBe(false);
    expect(capability.reason).toMatch(/tesseract/u);
    expect(capability.reason).toMatch(/tesseract-ocr/u);
  });

  it('names BOTH binaries when both are missing', () => {
    const capability = localOcr({
      recogniser: '/nonexistent/tesseract',
      rasteriser: '/nonexistent/pdftoppm',
    }).describe();

    expect(capability.reason).toMatch(/poppler-utils/u);
    expect(capability.reason).toMatch(/tesseract-ocr/u);
  });

  it('refuses to read rather than throwing when it cannot run', async () => {
    /*
     * The port says an engine must not throw for anything about the document
     * OR about itself: a throw becomes a crashed worker halfway through a
     * queue. This is the case most likely to throw — the binary is not there
     * at all.
     */
    const outcome = await localOcr({ recogniser: '/nonexistent/tesseract' }).read(PDF);

    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind === 'unavailable') expect(outcome.reason).toMatch(/not installed/u);
  });

  it('does not leave the PDF it was given lying about', async () => {
    /*
     * A customer's drawing must not be left as a loose file on the server for
     * somebody to find. The workspace is removed in a `finally`, including on
     * the path where nothing could be run — which is the path every deployment
     * with no engine takes on every job.
     */
    const workspaces = (): readonly string[] =>
      readdirSync(tmpdir()).filter((name) => name.startsWith('eje-ocr-'));

    const before = workspaces();
    await localOcr({ recogniser: '/nonexistent/tesseract' }).read(PDF);

    expect(workspaces()).toEqual(before);
  });
});
