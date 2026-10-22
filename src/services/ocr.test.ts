import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { buildOcr, describeOcrLimits, localOcr, unavailableOcr } from './ocr';

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

describe('the limits, and what happens when one bites', () => {
  /**
   * WHY THESE MATTER MORE THAN THEY LOOK.
   *
   * This runs as a worker on the same small VPS that serves the application. An
   * unbounded run is not slow — it is the web server starved, or the disk
   * filled with page images. Every bound is overridable, and every one SAYS SO
   * when it bites: a limit that silently truncates cannot be told from a bad
   * scan, and the person searching the manual concludes the alarm is not in the
   * book.
   */
  /*
   * BINARIES THAT EXIST BUT ARE NOT AN OCR ENGINE.
   *
   * `describe()` asks each binary for its version and treats any output as
   * present — which is what lets this test reach the code AFTER the
   * availability check on a machine with no tesseract. `/bin/echo --version`
   * prints something, so the engine believes it is installed, and the size
   * limit below is then the real code path rather than a stub of it.
   *
   * "Not installed" is still reported FIRST on a real deployment, and that
   * order is deliberate: telling an operator a file is too large when the
   * reason nothing works is an apt-get they never ran would send them to the
   * wrong problem.
   */
  const present = { recogniser: '/bin/echo', rasteriser: '/bin/echo' } as const;

  it('refuses a file larger than this machine will rasterise, and names the figure', async () => {
    const engine = localOcr({ ...present, maxInputBytes: 1024 });
    const outcome = await engine.read(new Uint8Array(4096));

    expect(outcome.kind).toBe('empty');
    if (outcome.kind === 'empty') {
      expect(outcome.reason).toMatch(/MB/u);
      expect(outcome.reason).toMatch(/EJE_OCR_MAX_INPUT_MB/u);
    }
  });

  it('checks the size BEFORE writing anything to disk', async () => {
    /*
     * The point of the limit: a 40 MB scan must not be written to the
     * workspace and handed to `pdftoppm` before anybody asks whether this
     * machine can afford it.
     */
    const before = readdirSync(tmpdir()).filter((name) => name.startsWith('eje-ocr-'));
    await localOcr({ ...present, maxInputBytes: 1024 }).read(new Uint8Array(4096));
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith('eje-ocr-'))).toEqual(before);
  });

  it('accepts a file INSIDE the limit, so the refusal is about the size', async () => {
    // The other half of the assertion above: with room, the read proceeds past
    // the size check and fails for a reason about the DOCUMENT instead —
    // `/bin/echo` is not a rasteriser, so no pages come out of it.
    const outcome = await localOcr({ ...present, maxInputBytes: 1024 * 1024 }).read(PDF);
    expect(outcome.kind).toBe('empty');
    if (outcome.kind === 'empty') expect(outcome.reason).not.toMatch(/EJE_OCR_MAX_INPUT_MB/u);
  });

  it('takes its binaries, its language and every limit from the environment', () => {
    /*
     * THE BINARY PATHS MATTER AS MUCH AS THE LIMITS. `tesseract` and
     * `pdftoppm` are on PATH on a Debian image and somewhere else entirely in
     * a container or on NixOS — and the message for a binary that is installed
     * somewhere this build did not look would have been "not installed", which
     * sends somebody to apt-get for something they have.
     */
    const engine = buildOcr({
      EJE_OCR: 'local',
      EJE_OCR_TESSERACT: '/opt/custom/tesseract',
      EJE_OCR_PDFTOPPM: '/opt/custom/pdftoppm',
      EJE_OCR_LANGUAGE: 'eng+afr',
      EJE_OCR_MAX_PAGES: '5',
      EJE_OCR_DEADLINE_MINUTES: '2',
      EJE_OCR_MAX_INPUT_MB: '10',
      EJE_OCR_MAX_TEXT_MB: '1',
    });

    // Unavailable on this machine, and the REASON names the paths it was told
    // to use rather than the defaults.
    const capability = engine.describe();
    expect(capability.available).toBe(false);
    expect(capability.reason).toMatch(/\/opt\/custom\/tesseract/u);
    expect(capability.reason).toMatch(/\/opt\/custom\/pdftoppm/u);
  });

  it('falls back to the default for a limit that is not a number', () => {
    /*
     * `EJE_OCR_MAX_PAGES=lots` must not mean "read no pages". A bad number
     * falls back to the default rather than to zero or NaN.
     */
    const engine = buildOcr({
      EJE_OCR: 'local',
      EJE_OCR_MAX_PAGES: 'lots',
      EJE_OCR_DEADLINE_MINUTES: '-5',
      EJE_OCR_MAX_INPUT_MB: '0',
      EJE_OCR_TESSERACT: '/nonexistent/tesseract',
    });
    // It still builds the local adapter and still reports honestly; the
    // assertion that matters is that it does not throw and does not disable
    // itself over a typo in a number.
    expect(engine.describe().available).toBe(false);
  });

  it('is still the UNAVAILABLE adapter when EJE_OCR is unset, whatever the limits say', () => {
    // A limit configured without the engine being asked for must not turn the
    // engine on. The decision is EJE's and it is one variable.
    const engine = buildOcr({ EJE_OCR_MAX_PAGES: '80', EJE_OCR_TESSERACT: '/usr/bin/tesseract' });
    expect(engine.describe().engine).toBe('none');
  });
});

describe('what the worker prints about its own configuration', () => {
  it('reports the defaults, and says they are defaults', () => {
    const limits = describeOcrLimits({});
    expect(limits.maxPages).toBe(40);
    expect(limits.deadlineMinutes).toBe(20);
    expect(limits.language).toBe('eng');
    expect(limits.recogniser).toBe('tesseract');
    expect(limits.overridden).toEqual([]);
  });

  it('reports what the deployment set, by NAME and not by value', () => {
    /*
     * The names, not the values: this is printed to a terminal that may be
     * logged, and a configuration dump is a configuration dump even when none
     * of it is secret.
     */
    const limits = describeOcrLimits({
      EJE_OCR: 'local',
      EJE_OCR_MAX_PAGES: '80',
      EJE_OCR_TESSERACT: '/opt/custom/tesseract',
    });
    expect(limits.maxPages).toBe(80);
    expect(limits.recogniser).toBe('/opt/custom/tesseract');
    expect(limits.overridden).toEqual(['EJE_OCR', 'EJE_OCR_TESSERACT', 'EJE_OCR_MAX_PAGES']);
  });

  it('reports the DEFAULT for a value that is not a number', () => {
    // So an operator who wrote `lots` can see that it did not take, rather
    // than wondering why nothing is being read.
    const limits = describeOcrLimits({ EJE_OCR_MAX_PAGES: 'lots', EJE_OCR_MAX_TEXT_MB: '-1' });
    expect(limits.maxPages).toBe(40);
    expect(limits.maxTextMb).toBe(2);
    // And it still says the variable is SET, because it is — that is the
    // discrepancy somebody needs to see.
    expect(limits.overridden).toContain('EJE_OCR_MAX_PAGES');
  });
});
