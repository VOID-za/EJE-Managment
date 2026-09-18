import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { A4_HEIGHT, A4_WIDTH } from './writer';
import type { SignatureBox } from './inspect';

/**
 * Renders a PDF through a real PDF engine and counts the ink in a region.
 *
 * Every earlier check on this document reasoned about the bytes: the strings it
 * contained, the coordinates it claimed, whether a facsimile had been decided
 * on. All of them passed while the signature was invisible in the file people
 * actually downloaded. The only check that could have caught that is looking at
 * the rendered pixels.
 *
 * So this opens the PDF in Chromium — the same engine a customer opens it in —
 * screenshots the page, finds the page's own white rectangle in that screenshot
 * so PDF points can be mapped to pixels, and counts how many pixels in a given
 * region are dark. A region that should hold a signature and holds no dark
 * pixels is the failure this exists to detect.
 *
 * Test-only: it needs a browser, so it is never imported by the application.
 */

/**
 * Launches Chromium, explaining itself if it cannot.
 *
 * `PLAYWRIGHT_CHROMIUM` wins when set, otherwise Playwright's own install is
 * used, and a missing browser fails with what to do about it rather than being
 * quietly skipped — a skipped check on this document is how the missing
 * signature survived three rounds of review.
 */
const launchChromium = async (chromium: {
  launch: (options?: { executablePath?: string }) => Promise<Browser>;
}) => {
  const explicit = process.env.PLAYWRIGHT_CHROMIUM;
  try {
    return await chromium.launch(explicit === undefined ? {} : { executablePath: explicit });
  } catch (error) {
    throw new Error(
      'Could not start Chromium, so the rendered PDF cannot be checked. Install the ' +
        'browsers with `npx playwright install chromium`, or point PLAYWRIGHT_CHROMIUM ' +
        `at an existing binary. Cause: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export interface InkReport {
  /** Dark pixels inside the region. */
  readonly ink: number;
  /** Pixels examined, so a caller can reason about proportion. */
  readonly examined: number;
  /** Where the screenshot was written, for looking at. */
  readonly screenshot: string;
  /** The page rectangle found in the screenshot, for diagnosing a bad mapping. */
  readonly page: {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly scale: number;
  };
  /** The pixel rectangle that was counted. */
  readonly region: {
    readonly x0: number;
    readonly x1: number;
    readonly y0: number;
    readonly y1: number;
  };
}

const DARK = 140;

export const renderPdfRegionInk = async (
  bytes: Uint8Array,
  box: SignatureBox,
  options: { readonly label?: string } = {},
): Promise<InkReport> => {
  // Imported here so the application bundle never reaches for a browser.
  const { chromium } = await import('playwright');

  const directory = mkdtempSync(join(tmpdir(), 'eje-pdf-'));
  const file = join(directory, `${options.label ?? 'document'}.pdf`);
  writeFileSync(file, bytes);
  const screenshot = join(directory, `${options.label ?? 'document'}-page-${box.page}.png`);

  const browser = await launchChromium(chromium);

  try {
    const viewer = await browser.newPage({ viewport: { width: 1100, height: 1700 } });
    /*
     * The viewer's own open parameters put the requested page on screen, whole.
     *
     * Scrolling to it with wheel events overshot to the end of the document and
     * left the page's top edge off screen, which broke the mapping from PDF
     * points to pixels. `page` selects the page and `view=Fit` guarantees all
     * of it is visible, so the page rectangle found below is the complete page.
     */
    await viewer.goto(`file://${file}#page=${box.page}&view=Fit&toolbar=0`, {
      waitUntil: 'load',
      timeout: 40000,
    });
    await viewer.waitForTimeout(4000);

    await viewer.screenshot({ path: screenshot });
    const png = await viewer.screenshot();
    await viewer.close();

    /*
     * The counting happens inside a browser page rather than by decoding the
     * PNG here: a canvas gives exact pixels with no image library, and the
     * page rectangle is found from the screenshot itself, so the mapping from
     * PDF points to pixels does not depend on the viewer's zoom.
     */
    const analyser = await browser.newPage();
    const report = await analyser.evaluate(
      async ([dataUrl, region, pageWidth, pageHeight, darkThreshold]) => {
        const image = new Image();
        await new Promise((resolve, reject) => {
          image.onload = resolve;
          image.onerror = reject;
          image.src = dataUrl as string;
        });

        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d');
        if (context === null) throw new Error('no 2d context');
        context.drawImage(image, 0, 0);
        const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);

        const at = (x: number, y: number): [number, number, number] => {
          const index = (y * width + x) * 4;
          return [data[index] ?? 0, data[index + 1] ?? 0, data[index + 2] ?? 0];
        };
        const isPaper = (x: number, y: number): boolean => {
          const [r, g, b] = at(x, y);
          return r > 235 && g > 235 && b > 235;
        };

        /*
         * Find the page rectangle by PAPER DENSITY, not by scanning one row.
         *
         * A single row breaks wherever text or a rule crosses it, which put the
         * page's left edge hundreds of pixels inside the page and made the
         * measured region land on blank paper. Counting paper pixels per column
         * and per row is immune to that: the page's columns are almost all
         * paper, the viewer's thumbnail sidebar has far fewer, and the
         * background has none.
         */
        const runOverThreshold = (counts: number[], threshold: number) => {
          let best = { start: -1, end: -2 };
          let runStart = -1;
          for (let index = 0; index <= counts.length; index += 1) {
            const inRun = index < counts.length && (counts[index] ?? 0) >= threshold;
            if (inRun && runStart === -1) runStart = index;
            if (!inRun && runStart !== -1) {
              if (index - 1 - runStart > best.end - best.start) {
                best = { start: runStart, end: index - 1 };
              }
              runStart = -1;
            }
          }
          return best;
        };

        const columnPaper: number[] = [];
        for (let x = 0; x < width; x += 1) {
          let count = 0;
          for (let y = 0; y < height; y += 2) if (isPaper(x, y)) count += 1;
          columnPaper.push(count);
        }
        const columnPeak = Math.max(...columnPaper);
        if (columnPeak === 0) throw new Error('no page found in the screenshot');
        const horizontal = runOverThreshold(columnPaper, columnPeak * 0.6);
        if (horizontal.start === -1) throw new Error('no page columns found');

        const left = horizontal.start;
        const right = horizontal.end;

        /*
         * The page's top and bottom come from a column just inside its left
         * edge, in the gutter where the document never draws anything.
         *
         * Counting paper per row does not work: a full-width dark rule — the
         * heavy one above the acceptance block — reads as a row with no paper
         * and splits the page into two shorter bands, which put the top edge
         * hundreds of pixels down the page and measured the wrong region. The
         * gutter has no rules and no text, so a contiguous run there is the
         * page.
         */
        const probe = Math.min(width - 1, left + 3);
        const columnRun = runOverThreshold(
          Array.from({ length: height }, (_, y) => (isPaper(probe, y) ? 1 : 0)),
          1,
        );
        const vertical = columnRun;

        const pageWidthPx = right - left + 1;
        const scale = pageWidthPx / (pageWidth as number);
        // A page taller than the window is cropped, so anchor on its top edge.
        const pageTop = vertical.start;

        const r = region as { x: number; y: number; width: number; height: number };
        // PDF space has its origin bottom-left; a screenshot's is top-left.
        const x0 = Math.round(left + r.x * scale);
        const x1 = Math.round(left + (r.x + r.width) * scale);
        const y0 = Math.round(pageTop + ((pageHeight as number) - (r.y + r.height)) * scale);
        const y1 = Math.round(pageTop + ((pageHeight as number) - r.y) * scale);

        let ink = 0;
        let examined = 0;
        for (let y = Math.max(0, y0); y <= Math.min(height - 1, y1); y += 1) {
          for (let x = Math.max(0, x0); x <= Math.min(width - 1, x1); x += 1) {
            const [red, green, blue] = at(x, y);
            examined += 1;
            if (
              red < (darkThreshold as number) &&
              green < (darkThreshold as number) &&
              blue < (darkThreshold as number)
            ) {
              ink += 1;
            }
          }
        }
        return {
          ink,
          examined,
          page: { left, right, top: pageTop, scale },
          region: { x0, x1, y0, y1 },
        };
      },
      [
        `data:image/png;base64,${Buffer.from(png).toString('base64')}`,
        { x: box.x, y: box.y, width: box.width, height: box.height },
        A4_WIDTH,
        A4_HEIGHT,
        DARK,
      ] as const,
    );
    await analyser.close();

    return {
      ink: report.ink,
      examined: report.examined,
      screenshot,
      page: report.page,
      region: report.region,
    };
  } finally {
    await browser.close();
  }
};
