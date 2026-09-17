import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { SIGNATURE_INK, SIGNATURE_STROKE_WIDTH, strokesToPath } from '@/lib/signature';

/**
 * Signature ink.
 *
 * The defect this guards against: the signature was drawn in
 * `--color-steel-900`, a dark blue-grey that reads as faded on a printed job
 * card — and which the dark theme redefines as near-white. A signature is a
 * facsimile of ink, so it is pure black everywhere it appears, and the capture
 * pad, the job card and the parts collection note all read it from one place.
 */
const source = (file: string): string =>
  readFileSync(new URL(file, import.meta.url), 'utf8');

describe('SIGNATURE_INK', () => {
  it('is pure black, not a palette token', () => {
    expect(SIGNATURE_INK).toBe('#000000');
  });

  it('carries a stroke width, so the shape is not rescaled per surface', () => {
    expect(SIGNATURE_STROKE_WIDTH).toBe(2);
  });
});

describe('the signature components', () => {
  const pad = source('./SignaturePad.tsx');

  it('draw every signature from the shared ink constant', () => {
    // Two paths (the capture pad and the rendered display) plus the script-font
    // fallback used by seeded demo signatures.
    const uses = pad.match(/SIGNATURE_INK/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(3);
  });

  it('no longer tint any signature with a theme-dependent grey', () => {
    // `--color-steel-900` inverts to near-white under the dark theme, and
    // `text-steel-700` was the light grey on the rendered signature.
    expect(pad).not.toContain('var(--color-steel-900)');
    expect(pad).not.toContain('text-steel-700 italic');
  });

  it('pin the capture surface to the light palette, so black ink is visible', () => {
    // Without this the customer would sign in black on the dark theme's dark
    // surface and see nothing.
    expect(pad).toContain('data-theme="light"');
  });
});

describe('the captured shape', () => {
  it('is preserved exactly — colour is the only thing that changed', () => {
    const strokes = [
      [
        { x: 0.1, y: 0.5 },
        { x: 0.2, y: 0.4 },
        { x: 0.3, y: 0.6 },
      ],
    ];
    // Normalised coordinates, so the same path renders at any size without
    // distortion; the ink change must not touch this.
    expect(strokesToPath(strokes)).toBe('M0.100,0.500 L0.200,0.400 L0.300,0.600');
  });

  it('keeps every point of a multi-stroke signature', () => {
    const strokes = [
      [
        { x: 0, y: 0 },
        { x: 0.5, y: 0.5 },
      ],
      [
        { x: 0.6, y: 0.1 },
        { x: 0.9, y: 0.2 },
      ],
    ];
    expect(strokesToPath(strokes)).toBe(
      'M0.000,0.000 L0.500,0.500 M0.600,0.100 L0.900,0.200',
    );
  });
});

describe('the documents that print a signature', () => {
  it('render it through the shared component rather than their own markup', () => {
    for (const file of ['./JobCardDocument.tsx', './PartsCollectionNote.tsx']) {
      const contents = source(file);
      expect(contents).toContain('<SignatureDisplay');
      // No document draws its own signature path, which is what would let one
      // of them drift back to grey.
      expect(contents).not.toContain('strokeLinecap');
    }
  });
});
