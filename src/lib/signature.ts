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

/*
 * ONE SHAPE FOR EVERY SIGNATURE. SIG-MOBILE-1 (the tester, 2 November 2026).
 *
 * A path is stored in a unit square, and every place that shows one — the
 * on-screen job card, the delivery note and the PDFs — draws it into a wide
 * box. The pad used to normalise x by ITS width and y by ITS height, so the
 * shape of the pad was lost: a desktop pad is about 4:1, which matched the
 * box, but a phone pad is about 1.6:1, and its signature came out squashed to
 * a fraction of its height — "only about one line". Now the pad maps its
 * drawing into a fixed 4:1 signature space, scaled the same both ways and
 * centred, and every renderer draws that space at 4:1. Nothing is distorted
 * on any screen.
 */
export const SIGNATURE_ASPECT = 4;

const fitPad = (width: number, height: number) => {
  const scale = Math.min(SIGNATURE_ASPECT / width, 1 / height);
  return { scale, offsetX: (SIGNATURE_ASPECT - width * scale) / 2, offsetY: (1 - height * scale) / 2 };
};

/** A point on a pad of the given pixel size, in the stored signature space. */
export const padToSignature = (x: number, y: number, width: number, height: number): SignaturePoint => {
  const { scale, offsetX, offsetY } = fitPad(width, height);
  return { x: (offsetX + x * scale) / SIGNATURE_ASPECT, y: offsetY + y * scale };
};

/** The inverse: a stored point, in pixels on a pad of the given size. */
export const signatureToPad = (point: SignaturePoint, width: number, height: number): SignaturePoint => {
  const { scale, offsetX, offsetY } = fitPad(width, height);
  return { x: (point.x * SIGNATURE_ASPECT - offsetX) / scale, y: (point.y - offsetY) / scale };
};

/** The largest 4:1 box inside `box`, centred: where a renderer draws a stored signature. */
export const fitSignatureBox = <T extends { x: number; y: number; width: number; height: number }>(box: T): T => {
  const width = Math.min(box.width, box.height * SIGNATURE_ASPECT);
  const height = width / SIGNATURE_ASPECT;
  return { ...box, x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height };
};
