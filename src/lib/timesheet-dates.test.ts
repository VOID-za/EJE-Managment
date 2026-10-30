import { describe, expect, it } from 'vitest';
import { lineDateProblem } from './timesheet-dates';

/**
 * THE 30 OCTOBER 2026 TIMESHEET FREEZE. A date field reports '' while any part
 * of the date is cleared or retyped, and in-between dates as digits arrive.
 * Those are states of typing: they are named in the form, never acted on.
 * The browser regression is the smoke step "a technician types a whole
 * timesheet line, retyping the date, and it is saved exactly as typed".
 */
describe('the date typed on a timesheet line', () => {
  const from = '2026-10-01';
  const to = '2026-10-30';
  const today = '2026-10-30';

  it('accepts a day of the timesheet that has happened', () => {
    expect(lineDateProblem('2026-10-05', from, to, today)).toBeNull();
    expect(lineDateProblem(from, from, to, today)).toBeNull();
    expect(lineDateProblem(to, from, to, today)).toBeNull();
  });

  it('names the half-typed states the field reports, instead of acting on them', () => {
    expect(lineDateProblem('', from, to, today)).toMatch(/whole date/u);
    // What Chrome reports after the first digit of a retyped year: not a whole date yet.
    expect(lineDateProblem('0002-10-05', from, to, today)).toMatch(/whole date/u);
    // A whole date on the way to the one meant, outside this timesheet.
    expect(lineDateProblem('2020-10-05', from, to, today)).toMatch(/Choose a day in this timesheet/u);
    expect(lineDateProblem('2026-02-30', from, to, today)).toMatch(/whole date/u);
  });

  it('refuses a day outside the period, and one that has not happened', () => {
    expect(lineDateProblem('2026-09-30', from, to, today)).toMatch(/Choose a day in this timesheet/u);
    expect(lineDateProblem('2026-10-31', from, '2026-10-31', today)).toMatch(/not happened yet/u);
  });
});
