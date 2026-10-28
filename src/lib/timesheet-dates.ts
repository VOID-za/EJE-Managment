/**
 * CALENDAR ARITHMETIC FOR TIMESHEETS. TS-04, TS-05 (28 October 2026).
 *
 * Every value here is a CALENDAR DATE (`YYYY-MM-DD`) or month (`YYYY-MM`), never
 * an instant. They are read with `Date.UTC` and `getUTC*`, so the machine's own
 * time zone can never move a day into the one before or after it — the defect a
 * `new Date('2026-10-26')` printed in South African time is one bad conversion
 * away from. Pure: the same answer on the server, in the browser and in the PDF
 * Layout.
 */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/u;

/** A real calendar day as `YYYY-MM-DD` (not 2026-02-30). */
export const isCalendarDay = (value: string): boolean => {
  const match = DATE_PATTERN.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const at = new Date(Date.UTC(year, month - 1, day));
  return at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day;
};

export const isCalendarMonth = (value: string): boolean => MONTH_PATTERN.test(value);

const utcDay = (iso: string): Date => {
  const [year, month, day] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day));
};

/** "Mon" for 2026-10-26. */
export const weekdayOf = (iso: string): string => WEEKDAYS[utcDay(iso).getUTCDay()]!;

/** "Monday" for 2026-10-26. */
export const weekdayLongOf = (iso: string): string => WEEKDAYS_LONG[utcDay(iso).getUTCDay()]!;

/** "Mon 26 Oct 2026": the day of the week beside the date, as the sheet prints it. */
export const formatDayAndDate = (iso: string): string => {
  const at = utcDay(iso);
  return `${WEEKDAYS[at.getUTCDay()]} ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]!.slice(0, 3)} ${at.getUTCFullYear()}`;
};

/** The month a day falls in: 2026-10-26 → 2026-10. */
export const monthOf = (iso: string): string => iso.slice(0, 7);

/** "October 2026". */
export const formatMonth = (month: string): string => {
  const [year, index] = month.split('-').map(Number) as [number, number];
  return `${MONTHS[index - 1]} ${year}`;
};

/** The first and last calendar day of a month. */
export const monthBounds = (month: string): { readonly from: string; readonly to: string } => {
  const [year, index] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(year, index, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
};

/** Every month a range touches, oldest first. */
export const monthsBetween = (from: string, to: string): readonly string[] => {
  const months: string[] = [];
  let [year, index] = monthOf(from).split('-').map(Number) as [number, number];
  const end = monthOf(to);
  for (;;) {
    const month = `${year}-${String(index).padStart(2, '0')}`;
    months.push(month);
    if (month >= end) break;
    index += 1;
    if (index > 12) {
      index = 1;
      year += 1;
    }
  }
  return months;
};

/**
 * The range the timesheet page opens on: the first of the current month to
 * today. Every visit starts here — the filters are not remembered — and that
 * reset touches only the two filter boxes, never a saved line.
 */
export const defaultTimesheetRange = (today: string): { readonly from: string; readonly to: string } => ({
  from: `${monthOf(today)}-01`,
  to: today,
});

/**
 * Why a From/To pair cannot be shown, or null when it can. The screen asks
 * this before querying; the server asks the same questions again.
 */
export const timesheetRangeProblem = (from: string, to: string, maxDays: number): string | null => {
  if (!isCalendarDay(from) || !isCalendarDay(to)) return 'Choose both a From and a To date.';
  if (from > to) return 'From must be on or before To.';
  const days = (utcDay(to).getTime() - utcDay(from).getTime()) / 86_400_000 + 1;
  if (days > maxDays) return `Choose at most ${maxDays} days.`;
  return null;
};
