import { describe, expect, it } from 'vitest';
import { dateReceivedProblem } from './date-received';

/** Test & Repair "Date Received": optional, a real day, never in the future. */
describe('the date a unit was received', () => {
  const NOW = '2026-10-25T10:00:00.000Z';

  it('is optional: nothing recorded is not a problem', () => {
    expect(dateReceivedProblem(null, NOW)).toBeNull();
  });

  it('accepts today and any day before it', () => {
    expect(dateReceivedProblem('2026-10-25', NOW)).toBeNull();
    expect(dateReceivedProblem('2026-01-01', NOW)).toBeNull();
  });

  it('accepts the office’s today when the server’s UTC clock is still on yesterday', () => {
    // 23:30 UTC on the 24th is 01:30 on the 25th in South Africa.
    expect(dateReceivedProblem('2026-10-25', '2026-10-24T23:30:00.000Z')).toBeNull();
  });

  it('refuses a day that has not happened yet', () => {
    expect(dateReceivedProblem('2026-10-27', NOW)).toMatch(/future/);
    expect(dateReceivedProblem('2999-01-01', NOW)).toMatch(/future/);
  });

  it('refuses a date that is not a real day', () => {
    expect(dateReceivedProblem('2026-02-30', NOW)).toMatch(/not a real date/);
    expect(dateReceivedProblem('2026-13-01', NOW)).toMatch(/not a real date/);
  });

  it('refuses something that is not a calendar date at all', () => {
    expect(dateReceivedProblem('25/10/2026', NOW)).toMatch(/calendar date/);
    expect(dateReceivedProblem('', NOW)).toMatch(/calendar date/);
  });
});
