import type { IsoDate } from '@/domain';
import type { CalendarEntry } from '@/application/calendar';

/**
 * Calendar geometry.
 *
 * Pure date arithmetic and lane packing, separated from rendering so the layout
 * can be reasoned about and tested without a DOM. All dates are handled as
 * calendar dates (no time, no zone) to avoid a job jumping a day across a
 * daylight-saving boundary.
 */
export type CalendarView = 'day' | 'week' | 'month' | 'year';

export const toIso = (date: Date): IsoDate =>
  `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}-${`${date.getDate()}`.padStart(2, '0')}`;

export const fromIso = (date: IsoDate): Date => new Date(`${date}T00:00:00`);

export const addDays = (date: IsoDate, days: number): IsoDate => {
  const next = fromIso(date);
  next.setDate(next.getDate() + days);
  return toIso(next);
};

export const addMonths = (date: IsoDate, months: number): IsoDate => {
  const next = fromIso(date);
  next.setDate(1);
  next.setMonth(next.getMonth() + months);
  return toIso(next);
};

/** Monday-first, which is how a workshop week is planned. */
export const startOfWeek = (date: IsoDate): IsoDate => {
  const parsed = fromIso(date);
  const weekday = (parsed.getDay() + 6) % 7;
  return addDays(date, -weekday);
};

export const startOfMonth = (date: IsoDate): IsoDate => `${date.slice(0, 7)}-01`;

export const endOfMonth = (date: IsoDate): IsoDate => {
  const parsed = fromIso(date);
  return toIso(new Date(parsed.getFullYear(), parsed.getMonth() + 1, 0));
};

export const rangeOfDays = (from: IsoDate, to: IsoDate): readonly IsoDate[] => {
  const days: IsoDate[] = [];
  for (let cursor = from; cursor <= to; cursor = addDays(cursor, 1)) days.push(cursor);
  return days;
};

/** The visible window for a view, including the leading and trailing days a month grid shows. */
export const viewRange = (view: CalendarView, anchor: IsoDate): { from: IsoDate; to: IsoDate } => {
  switch (view) {
    case 'day':
      return { from: anchor, to: anchor };
    case 'week': {
      const from = startOfWeek(anchor);
      return { from, to: addDays(from, 6) };
    }
    case 'month': {
      const from = startOfWeek(startOfMonth(anchor));
      const lastRowStart = startOfWeek(endOfMonth(anchor));
      return { from, to: addDays(lastRowStart, 6) };
    }
    case 'year':
      return { from: `${anchor.slice(0, 4)}-01-01`, to: `${anchor.slice(0, 4)}-12-31` };
  }
};

export interface PositionedEntry {
  readonly entry: CalendarEntry;
  /** Zero-based column within the week row. */
  readonly offset: number;
  /** Number of columns this bar covers in THIS row. */
  readonly span: number;
  /** Vertical lane, so overlapping bars do not collide. */
  readonly lane: number;
  /** The entry continues before or after this row. */
  readonly continuesBefore: boolean;
  readonly continuesAfter: boolean;
}

/**
 * Packs entries into lanes for one week row.
 *
 * A multi-day entry is clipped to the row and marked as continuing, which is how
 * a service spanning a week boundary reads correctly on both rows.
 */
export const packWeek = (
  entries: readonly CalendarEntry[],
  weekStart: IsoDate,
): readonly PositionedEntry[] => {
  const weekEnd = addDays(weekStart, 6);
  const lanes: IsoDate[] = [];
  const positioned: PositionedEntry[] = [];

  for (const entry of entries) {
    if (entry.start > weekEnd || entry.end < weekStart) continue;

    const visibleStart = entry.start < weekStart ? weekStart : entry.start;
    const visibleEnd = entry.end > weekEnd ? weekEnd : entry.end;

    const offset = rangeOfDays(weekStart, visibleStart).length - 1;
    const span = rangeOfDays(visibleStart, visibleEnd).length;

    // First lane whose last occupied day is before this entry starts.
    let lane = lanes.findIndex((occupiedUntil) => occupiedUntil < visibleStart);
    if (lane === -1) {
      lane = lanes.length;
      lanes.push(visibleEnd);
    } else {
      lanes[lane] = visibleEnd;
    }

    positioned.push({
      entry,
      offset,
      span,
      lane,
      continuesBefore: entry.start < weekStart,
      continuesAfter: entry.end > weekEnd,
    });
  }

  return positioned.sort((a, b) => a.lane - b.lane || a.offset - b.offset);
};

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export const isWeekend = (date: IsoDate): boolean => {
  const day = fromIso(date).getDay();
  return day === 0 || day === 6;
};

/** Label for the period a view is showing. */
export const viewLabel = (view: CalendarView, anchor: IsoDate): string => {
  const parsed = fromIso(anchor);
  const month = MONTH_NAMES[parsed.getMonth()] ?? '';

  switch (view) {
    case 'day':
      return `${parsed.getDate()} ${month} ${parsed.getFullYear()}`;
    case 'week': {
      const from = startOfWeek(anchor);
      const to = addDays(from, 6);
      const fromParsed = fromIso(from);
      const toParsed = fromIso(to);
      const fromMonth = MONTH_NAMES[fromParsed.getMonth()]?.slice(0, 3) ?? '';
      const toMonth = MONTH_NAMES[toParsed.getMonth()]?.slice(0, 3) ?? '';
      return `${fromParsed.getDate()} ${fromMonth} – ${toParsed.getDate()} ${toMonth} ${toParsed.getFullYear()}`;
    }
    case 'month':
      return `${month} ${parsed.getFullYear()}`;
    case 'year':
      return String(parsed.getFullYear());
  }
};
