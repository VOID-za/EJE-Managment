import { WORKSHOP_LABEL, type TimesheetLineTyped } from '@/domain';
import { WORKSHOP_PICK, parseTyped, randToCents } from './timesheet-line';

/**
 * ONE DAY OF THE OPEN TIMESHEET (TS-DAY-1, the owner, 6 November 2026).
 *
 * The Timesheets page shows each date as one block, and each customer, site or
 * Workshop visited that day as a line inside it. Nothing is stored for the day
 * itself: on EJE's paper Time Sheet (TS-PAPER-1) OT, D/T, the call-out and the
 * kilometres are written on the customer's row, so they stay on the visit. The
 * day's figures are ADDED UP from its visits, never typed a second time and
 * never stored — a day cannot count an hour twice, and the period's totals,
 * the PDF and Finance read the same visit lines as before.
 */

export interface DayVisit {
  readonly typed: TimesheetLineTyped;
}

export interface DaySummary {
  /** Lines (visits) the day holds. */
  readonly visits: number;
  /** Different customers, sites or Workshop among them; a visit with no customer named is not counted. */
  readonly places: number;
  /**
   * The names of those customers, sites or Workshop, each once, in the order the lines are (v1.7.1: the day's
   * heading names them — never "1 line · 1 customer/site").
   */
  readonly names: readonly string[];
  readonly overtime: number;
  readonly double: number;
  /** Cents. */
  readonly callout: number;
  readonly internalKm: number;
  readonly customerKm: number;
}

/** A value as typed, or 0 while it is not a number yet (the line says what is wrong with it). */
const usable = (value: number): number => (Number.isFinite(value) ? value : 0);

/** Adds two decimal values without the float drift (0.1 + 0.2), to `places` decimals. */
const add = (sum: number, value: number, places: number): number => {
  const scale = 10 ** places;
  return Math.round((sum + value) * scale) / scale;
};

export const placeOf = (typed: TimesheetLineTyped): string | null =>
  typed.pick === WORKSHOP_PICK ? WORKSHOP_PICK : typed.pick.length > 0 ? `id:${typed.pick}` : typed.customerName.trim().length > 0 ? `name:${typed.customerName.trim().toLowerCase()}` : null;

/** The day's figures: the sum of what each of its visits says, once each. */
export const summariseDay = (visits: readonly DayVisit[]): DaySummary => {
  const places = new Set<string>();
  const names: string[] = [];
  let overtime = 0;
  let double = 0;
  let callout = 0;
  let internalKm = 0;
  let customerKm = 0;
  for (const { typed } of visits) {
    const place = placeOf(typed);
    if (place !== null && !places.has(place)) {
      places.add(place);
      names.push(typed.pick === WORKSHOP_PICK ? WORKSHOP_LABEL : typed.customerName.trim());
    }
    overtime = add(overtime, usable(parseTyped(typed.overtime)), 2);
    double = add(double, usable(parseTyped(typed.double)), 2);
    callout += usable(randToCents(typed.callout));
    internalKm = add(internalKm, usable(parseTyped(typed.internalKm)), 1);
    customerKm = add(customerKm, usable(parseTyped(typed.customerKm)), 1);
  }
  return { visits: visits.length, places: places.size, names, overtime, double, callout, internalKm, customerKm };
};

/** The lines of each date, in the order given; a line with no date is not on any day. */
export const groupByDay = <T>(lines: readonly T[], dateOf: (line: T) => string | null): ReadonlyMap<string, readonly T[]> => {
  const days = new Map<string, T[]>();
  for (const line of lines) {
    const date = dateOf(line);
    if (date === null) continue;
    const day = days.get(date);
    if (day === undefined) days.set(date, [line]);
    else day.push(line);
  }
  return days;
};

export type DayState = 'empty' | 'saved' | 'saving' | 'draft' | 'failed';

/** Where the day stands, its worst line first: a failed save, then saving, then a draft. */
export const dayState = (states: readonly Exclude<DayState, 'empty'>[]): DayState =>
  states.length === 0
    ? 'empty'
    : states.includes('failed')
      ? 'failed'
      : states.includes('saving')
        ? 'saving'
        : states.includes('draft')
          ? 'draft'
          : 'saved';
