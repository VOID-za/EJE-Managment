import { describe, expect, it } from 'vitest';
import { daysInPeriod, lineDateProblem, timesheetRangeProblem } from './timesheet-dates';

/**
 * THE 30 OCTOBER 2026 TIMESHEET FREEZE. A date field reports '' while any part
 * of the date is cleared or retyped, and in-between dates as digits arrive.
 * Those are states of typing: they are named in the form, never acted on.
 * The browser regression is the smoke step "a technician types a whole
 * timesheet line, retyping the date, and it is saved exactly as typed".
 *
 * TS-PAPER (4 November 2026): any real date may be recorded — past, future,
 * before the last payday. Only a malformed one is named.
 */
describe('the date typed on a timesheet line', () => {
  it('accepts any real day: past, future, outside any pay period', () => {
    expect(lineDateProblem('2026-10-05')).toBeNull();
    expect(lineDateProblem('2026-12-25')).toBeNull();
    expect(lineDateProblem('2027-03-01')).toBeNull();
    expect(lineDateProblem('2025-01-15')).toBeNull();
  });

  it('names the half-typed states the field reports, instead of acting on them', () => {
    expect(lineDateProblem('')).toMatch(/whole date/u);
    // The year arriving digit by digit.
    expect(lineDateProblem('0002-10-05')).toMatch(/whole date/u);
    expect(lineDateProblem('0202-10-05')).toMatch(/whole date/u);
    expect(lineDateProblem('2026-02-30')).toMatch(/whole date/u);
  });
});

describe('the dates of a submission', () => {
  it('any length, From on or before To', () => {
    expect(timesheetRangeProblem('2026-12-16', '2027-01-25')).toBeNull();
    expect(timesheetRangeProblem('2026-08-26', '2026-12-15')).toBeNull();
    expect(daysInPeriod('2026-08-26', '2026-12-15')).toBe(112);
    expect(timesheetRangeProblem('2026-11-26', '2026-11-25')).toMatch(/on or before/u);
    expect(timesheetRangeProblem('', '2026-11-25')).toMatch(/both/u);
  });
});
