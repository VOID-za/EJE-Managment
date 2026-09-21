import { describe, expect, it } from 'vitest';
import { demoId } from './ids';

describe('seeded identifiers', () => {
  it('produces a valid version 5 UUID', () => {
    expect(demoId('customer:acme')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  it('is the same on every run, which is what makes the seed repeatable', () => {
    expect(demoId('customer:acme')).toBe(demoId('customer:acme'));
    // Pinned: changing this would orphan every record a previous run created.
    expect(demoId('customer:acme')).toBe('346c1237-f6a6-5fb4-b97f-530948291a23');
  });

  it('gives different names different ids', () => {
    const ids = new Set(
      ['customer:acme', 'customer:jia', 'site:acme:head', 'job:2001'].map(demoId),
    );
    expect(ids.size).toBe(4);
  });
});
