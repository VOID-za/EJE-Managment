import { describe, expect, it } from 'vitest';
import { isSignatureEmpty, strokesToPath, type SignatureStroke } from './signature-path';

/**
 * Signature geometry is extracted from the component precisely so it can be
 * tested without a DOM, and so the component's own logic reduces to event
 * handling — which is where the setState-during-render bug lived.
 */
const stroke = (...points: [number, number][]): SignatureStroke =>
  points.map(([x, y]) => ({ x, y }));

describe('strokesToPath', () => {
  it('serialises a single stroke to a move followed by lines', () => {
    expect(strokesToPath([stroke([0, 0], [0.5, 0.25], [1, 1])])).toBe(
      'M0.000,0.000 L0.500,0.250 L1.000,1.000',
    );
  });

  it('joins multiple strokes into one path', () => {
    const path = strokesToPath([stroke([0, 0], [0.1, 0.1]), stroke([0.5, 0.5], [0.6, 0.6])]);
    expect(path.match(/M/g)).toHaveLength(2);
  });

  it('ignores a stroke of a single point, which draws nothing', () => {
    expect(strokesToPath([stroke([0.2, 0.2])])).toBe('');
    expect(strokesToPath([stroke([0.2, 0.2]), stroke([0, 0], [1, 1])])).toBe(
      'M0.000,0.000 L1.000,1.000',
    );
  });

  it('returns an empty path for no strokes', () => {
    expect(strokesToPath([])).toBe('');
  });

  it('produces coordinates at fixed precision so signatures compare stably', () => {
    expect(strokesToPath([stroke([0.123456, 0.987654], [1, 1])])).toContain('0.123,0.988');
  });
});

describe('isSignatureEmpty', () => {
  it('treats no strokes and single-point taps as empty', () => {
    expect(isSignatureEmpty([])).toBe(true);
    expect(isSignatureEmpty([stroke([0.5, 0.5])])).toBe(true);
  });

  it('treats a drawn line as not empty', () => {
    expect(isSignatureEmpty([stroke([0, 0], [1, 1])])).toBe(false);
  });
});
