import { describe, expect, it } from 'vitest';
import { laterThan } from './timesheet-lines';

/** A line's revision is the moment it was written; two writes never share one (PAYROLL-ONE-1 follow-up). */
describe('laterThan', () => {
  it('is the clock when the clock has moved on', () => {
    expect(laterThan('2026-11-05T18:30:02.726Z', '2026-11-05T18:30:02.725Z')).toBe('2026-11-05T18:30:02.726Z');
    expect(laterThan('2026-11-05T18:30:02.726Z', null)).toBe('2026-11-05T18:30:02.726Z');
  });
  it('is one millisecond later when the clock has not moved — in ISO or as PostgreSQL writes it', () => {
    expect(laterThan('2026-11-05T18:30:02.725Z', '2026-11-05T18:30:02.725Z')).toBe('2026-11-05T18:30:02.726Z');
    expect(laterThan('2026-11-05T18:30:02.725Z', '2026-11-05 18:30:02.725+00')).toBe('2026-11-05T18:30:02.726Z');
    expect(laterThan('2026-11-05T18:30:02.000Z', '2026-11-05T20:30:02.725+02:00')).toBe('2026-11-05T18:30:02.726Z');
  });
});
