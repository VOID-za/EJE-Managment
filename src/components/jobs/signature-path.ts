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
