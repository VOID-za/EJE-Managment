import { describe, expect, it } from 'vitest';
import type { TimesheetLineTyped } from '@/domain';
import { dayState, groupByDay, summariseDay } from './timesheet-day';
import { WORKSHOP_PICK, emptyTimesheetLineTyped, parseTyped, randToCents } from './timesheet-line';

const visit = (patch: Partial<TimesheetLineTyped>) => ({ typed: { ...emptyTimesheetLineTyped(), ...patch } });

describe('TS-DAY-1 — one block per day, its figures added up from its lines', () => {
  it('a day with no line is not recorded: nothing is counted', () => {
    expect(summariseDay([])).toEqual({ visits: 0, places: 0, names: [], overtime: 0, double: 0, callout: 0, internalKm: 0, customerKm: 0 });
  });

  it('three visits on one day add up once each — nothing is copied from one line to the next', () => {
    const day = [
      visit({ customerName: 'Acme Mining', overtime: '1.5', double: '0', callout: '500', internalKm: '12.5', customerKm: '30' }),
      visit({ pick: WORKSHOP_PICK, overtime: '0.25', double: '2', callout: '0', internalKm: '0', customerKm: '0' }),
      visit({ customerName: 'Bravo Plant', overtime: '0.1', double: '0.2', callout: '250.50', internalKm: '0.1', customerKm: '0.2' }),
    ];
    expect(summariseDay(day)).toEqual({ visits: 3, places: 3, names: ['Acme Mining', 'Workshop', 'Bravo Plant'], overtime: 1.85, double: 2.2, callout: 75_050, internalKm: 12.6, customerKm: 30.2 });
  });

  it('the period total of day totals equals the total of the lines (what the PDF and Finance read)', () => {
    const lines = [
      { date: '2026-12-30', ...visit({ customerName: 'A', overtime: '2', callout: '100', customerKm: '5.5' }) },
      { date: '2026-12-30', ...visit({ customerName: 'B', overtime: '1.25', callout: '50' }) },
      { date: '2026-12-31', ...visit({ customerName: 'A', double: '3' }) },
      { date: '2027-01-01', ...visit({ pick: WORKSHOP_PICK, overtime: '4', internalKm: '7.3' }) },
    ];
    const days = groupByDay(lines, (line) => line.date);
    expect([...days.keys()]).toEqual(['2026-12-30', '2026-12-31', '2027-01-01']);
    const sum = [...days.values()].map(summariseDay);
    const of = (pick: (typed: TimesheetLineTyped) => number) => lines.reduce((total, line) => total + pick(line.typed), 0);
    expect(sum.reduce((total, day) => total + day.overtime, 0)).toBeCloseTo(of((typed) => parseTyped(typed.overtime)), 10);
    expect(sum.reduce((total, day) => total + day.double, 0)).toBeCloseTo(of((typed) => parseTyped(typed.double)), 10);
    expect(sum.reduce((total, day) => total + day.callout, 0)).toBe(of((typed) => randToCents(typed.callout)));
    expect(sum.reduce((total, day) => total + day.customerKm + day.internalKm, 0)).toBeCloseTo(12.8, 10);
    expect(sum.reduce((total, day) => total + day.visits, 0)).toBe(lines.length);
  });

  it('the same customer twice is one place; a register pick and a typed name are told apart; an unnamed line is not a place', () => {
    expect(summariseDay([visit({ customerName: 'Acme' }), visit({ customerName: ' acme ' }), visit({ customerName: '' })]).places).toBe(1);
    expect(summariseDay([visit({ pick: 'cust-1', customerName: 'Acme' }), visit({ pick: 'cust-1', customerName: 'Acme' }), visit({ pick: WORKSHOP_PICK })]).places).toBe(2);
  });

  it('v1.7.1: the heading names each customer once, in line order — several are all named, none dropped', () => {
    const day = [visit({ customerName: 'Test' }), visit({ customerName: ' Acme Mining ' }), visit({ customerName: 'test' }), visit({ pick: WORKSHOP_PICK }), visit({ customerName: '' }), visit({ customerName: 'Bravo' })];
    expect(summariseDay(day).names).toEqual(['Test', 'Acme Mining', 'Workshop', 'Bravo']);
    expect(summariseDay([visit({ customerName: '' })]).names).toEqual([]);
  });

  it('a value not yet a number (a draft) adds nothing until it is fixed', () => {
    expect(summariseDay([visit({ customerName: 'A', overtime: '1..5', callout: 'abc' }), visit({ customerName: 'B', overtime: '2' })])).toMatchObject({ overtime: 2, callout: 0 });
  });

  it('a line with no date belongs to no day', () => {
    expect(groupByDay([{ date: null }, { date: '2026-11-06' }], (line) => line.date).size).toBe(1);
  });

  it('the day shows its worst line: Save failed, then Saving, then Draft, then Saved', () => {
    expect(dayState([])).toBe('empty');
    expect(dayState(['saved', 'saved'])).toBe('saved');
    expect(dayState(['saved', 'draft'])).toBe('draft');
    expect(dayState(['draft', 'saving'])).toBe('saving');
    expect(dayState(['saving', 'failed', 'saved'])).toBe('failed');
  });
});
