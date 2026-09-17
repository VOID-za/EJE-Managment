/**
 * Signature geometry.
 *
 * Pure, so it can be tested without a DOM. Points are normalised to 0..1 of the
 * pad so a signature reproduces at any size — the same representation the
 * production renderer will consume.
 */
export interface SignaturePoint {
  readonly x: number;
  readonly y: number;
}

export type SignatureStroke = readonly SignaturePoint[];

/** Serialises strokes to an SVG path. A stroke of one point draws nothing. */
export const strokesToPath = (strokes: readonly SignatureStroke[]): string =>
  strokes
    .filter((stroke) => stroke.length > 1)
    .map((stroke) =>
      stroke
        .map(
          (point, index) =>
            `${index === 0 ? 'M' : 'L'}${point.x.toFixed(3)},${point.y.toFixed(3)}`,
        )
        .join(' '),
    )
    .join(' ');

/** True when nothing has actually been drawn yet. */
export const isSignatureEmpty = (strokes: readonly SignatureStroke[]): boolean =>
  strokes.every((stroke) => stroke.length < 2);

/**
 * The colour a captured signature is drawn in, everywhere it appears.
 *
 * Pure black, not a palette token. A signature is a facsimile of ink on paper:
 * it has to be unambiguous on a printed job card, and `--color-steel-900` is a
 * dark blue-grey that reads as faded when printed — and inverts to near-white
 * under the dark theme. Declared once here so the capture pad, the on-screen
 * job-card preview and the generated document cannot drift apart.
 */
export const SIGNATURE_INK = '#000000';

/** Stroke width of a rendered signature, in CSS pixels. */
export const SIGNATURE_STROKE_WIDTH = 2;

/**
 * How a stored signature should be drawn.
 *
 * Seeded demonstration jobs carry a descriptive label (`demo-signature-pieter-nel`)
 * rather than captured geometry, because a seed cannot ship a real person's
 * signature. A signature captured in the application carries the real path.
 *
 * The decision lives here, once, so the on-screen job card and the PDF renderer
 * cannot disagree about what to put in the signature box — which is exactly how
 * the PDF came to have an empty one.
 */
export type SignatureFacsimile =
  | { readonly kind: 'path'; readonly path: string }
  | { readonly kind: 'name'; readonly text: string };

export const signatureFacsimile = (strokeData: string): SignatureFacsimile =>
  strokeData.startsWith('M')
    ? { kind: 'path', path: strokeData }
    : { kind: 'name', text: strokeData.replace(/^demo-signature-/, '').replace(/-/g, ' ') };
