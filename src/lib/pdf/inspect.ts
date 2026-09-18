import { charWidth, SUBSTITUTION_ALLOWANCE } from './metrics';
import { A4_HEIGHT, A4_WIDTH, type PdfFont } from './writer';

/**
 * Reads a rendered PDF back and measures what is actually on the page.
 *
 * Extracting a document's text proves it contains the right words; it proves
 * nothing about whether a reader can read them. A review found a final job card
 * whose contact details ran under the panel beside them and whose signature box
 * was empty, after a text-only check had passed.
 *
 * So this parses the content streams and measures every text run with the same
 * font metrics the renderer used — which is how a viewer lays it out — and
 * reports overruns, collisions and a missing signature as findings a test can
 * assert on.
 */

export interface TextRun {
  readonly page: number;
  readonly font: PdfFont;
  readonly size: number;
  readonly x: number;
  readonly y: number;
  readonly value: string;
  readonly width: number;
}

/** Where the signature mark sits, in PDF user space (origin bottom-left). */
export interface SignatureBox {
  readonly page: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PdfInspection {
  readonly pageCount: number;
  readonly runs: readonly TextRun[];
  /** How the signature is present, or null if it is not present at all. */
  readonly signature:
    | { readonly kind: 'drawn'; readonly segments: number; readonly box: SignatureBox }
    | { readonly kind: 'facsimile'; readonly text: string; readonly box: SignatureBox }
    | null;
  /** Human-readable geometry faults: overruns, collisions, off-page text. */
  readonly problems: readonly string[];
}

const FONT_BY_RESOURCE: Record<string, PdfFont> = {
  F1: 'regular',
  F2: 'bold',
  F3: 'italic',
  F4: 'script',
};

export const pdfText = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');

/**
 * The document's text as a reader sees it, one run per line.
 *
 * Searching the raw bytes is unreliable: PDF escapes brackets and backslashes
 * inside string literals, so "ABC Engineering (Pty) Ltd" is stored as
 * "ABC Engineering \(Pty\) Ltd" and a plain substring search misses it.
 */
export const pdfPlainText = (bytes: Uint8Array): string =>
  inspectPdf(bytes)
    .runs.map((run) => run.value)
    .join('\n');

/** The page content streams, in page order. */
const pageStreams = (text: string): readonly string[] => {
  const objects = new Map<number, string>();
  for (const match of text.matchAll(/(\d+) 0 obj\n([\s\S]*?)\nendobj/g)) {
    objects.set(Number(match[1]), match[2] ?? '');
  }
  const kids = /\/Kids \[(.*?)\]/.exec(text);
  if (kids === null) return [];

  return [...(kids[1] ?? '').matchAll(/(\d+) 0 R/g)]
    .map((match) => objects.get(Number(match[1])) ?? '')
    .map((page) => {
      const contents = /\/Contents (\d+) 0 R/.exec(page);
      const stream = contents === null ? '' : (objects.get(Number(contents[1])) ?? '');
      const body = /stream\n([\s\S]*)\nendstream/.exec(stream);
      return body === null ? '' : (body[1] ?? '');
    });
};

const TEXT_RUN =
  /BT [\d.]+ [\d.]+ [\d.]+ rg \/(F\d) ([\d.]+) Tf (?:([\d.]+) Tc )?1 0 0 1 ([\d.-]+) ([\d.-]+) Tm \((.*?)\) Tj ET/g;

const measure = (value: string, size: number, font: PdfFont, tracking: number): number => {
  let thousandths = 0;
  for (const character of value) thousandths += charWidth(character, font);
  // The same allowance the renderer lays out with: what a reader sees depends on
  // the font their viewer substitutes, not on the metrics table.
  return (
    ((thousandths / 1000) * size + tracking * [...value].length) * SUBSTITUTION_ALLOWANCE
  );
};

export const inspectPdf = (
  bytes: Uint8Array,
  options: { readonly margin?: number; readonly tolerance?: number } = {},
): PdfInspection => {
  const margin = options.margin ?? 40;
  const tolerance = options.tolerance ?? 1.5;
  const text = pdfText(bytes);
  const streams = pageStreams(text);

  const runs: TextRun[] = [];
  const problems: string[] = [];
  let signature: PdfInspection['signature'] = null;

  streams.forEach((stream, index) => {
    const page = index + 1;
    const pageRuns: TextRun[] = [];

    for (const match of stream.matchAll(TEXT_RUN)) {
      const font = FONT_BY_RESOURCE[match[1] ?? ''] ?? 'regular';
      const size = Number(match[2]);
      const tracking = match[3] === undefined ? 0 : Number(match[3]);
      const value = (match[6] ?? '').replace(/\\([\\()])/g, '$1');
      pageRuns.push({
        page,
        font,
        size,
        x: Number(match[4]),
        y: Number(match[5]),
        value,
        width: measure(value, size, font, tracking),
      });
    }

    if (pageRuns.length === 0) problems.push(`page ${page} has no text on it`);
    runs.push(...pageRuns);

    for (const run of pageRuns) {
      if (run.x + run.width > A4_WIDTH - margin + tolerance) {
        problems.push(
          `page ${page}: "${run.value.slice(0, 44)}" overruns the right margin by ` +
            `${(run.x + run.width - (A4_WIDTH - margin)).toFixed(1)}pt`,
        );
      }
      if (run.x < margin - tolerance) {
        problems.push(`page ${page}: "${run.value.slice(0, 44)}" starts left of the margin`);
      }
      if (run.y < 20 || run.y > A4_HEIGHT - 20) {
        problems.push(`page ${page}: "${run.value.slice(0, 44)}" sits off the page`);
      }
    }

    /*
     * A collision is two runs sharing a baseline whose boxes intersect — which
     * is exactly how a reader sees one word printed over another.
     *
     * Runs are grouped into baseline BANDS first and only then ordered by x.
     * Sorting by exact y instead reports a false collision whenever two columns
     * land a fraction of a point apart, because it puts the right-hand column
     * before the left-hand one.
     */
    const bands: TextRun[][] = [];
    for (const run of [...pageRuns].sort((a, b) => b.y - a.y)) {
      const band = bands[bands.length - 1];
      if (band !== undefined && Math.abs((band[0]?.y ?? 0) - run.y) <= 0.5) band.push(run);
      else bands.push([run]);
    }

    for (const band of bands) {
      const ordered = [...band].sort((a, b) => a.x - b.x);
      for (let index2 = 0; index2 < ordered.length - 1; index2 += 1) {
        const current = ordered[index2];
        const next = ordered[index2 + 1];
        if (current === undefined || next === undefined) continue;
        if (current.value.trim().length === 0 || next.value.trim().length === 0) continue;
        if (next.x < current.x + current.width - tolerance) {
          problems.push(
            `page ${page}: "${current.value.slice(0, 30)}" overlaps "${next.value.slice(0, 30)}"`,
          );
        }
      }
    }

    // The signature: the customer's own drawn geometry, or the script-face
    // facsimile the on-screen card falls back to for a seeded job.
    const script = pageRuns.filter((run) => run.font === 'script');
    // `1 J 1 j` — round caps and joins — is emitted only for a drawn signature.
    const signatureStroke = /[\d.]+ w 1 J 1 j ((?:[\d.-]+ [\d.-]+ [ml] ?)+)S/.exec(stream)?.[1] ?? null;

    if (script.length > 0) {
      const first = script[0]!;
      const last = script[script.length - 1]!;
      signature = {
        kind: 'facsimile',
        text: script.map((run) => run.value).join(' '),
        box: {
          page,
          x: first.x,
          // The baseline is the bottom of the glyphs; allow for descenders.
          y: first.y - first.size * 0.28,
          width: last.x + last.width - first.x,
          height: first.size * 1.15,
        },
      };
    } else if (signatureStroke !== null) {
      // Only the signature path is stroked with round caps and joins — page
      // rules are not — so this is the signature's own geometry and not the
      // bounding box of every line on the page.
      const points = [...signatureStroke.matchAll(/([\d.-]+) ([\d.-]+) (?:m|l)/g)].map(
        (match) => ({ x: Number(match[1]), y: Number(match[2]) }),
      );
      const xs = points.map((point) => point.x);
      const ys = points.map((point) => point.y);
      signature = {
        kind: 'drawn',
        segments: [...signatureStroke.matchAll(/[\d.-]+ [\d.-]+ l/g)].length,
        box: {
          page,
          x: Math.min(...xs),
          y: Math.min(...ys),
          width: Math.max(...xs) - Math.min(...xs),
          height: Math.max(...ys) - Math.min(...ys),
        },
      };
    }
  });

  return { pageCount: streams.length, runs, signature, problems };
};
