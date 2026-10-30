/**
 * CALENDAR ARITHMETIC FOR TIMESHEETS. TS-04, TS-05 (28 October 2026).
 *
 * Every value here is a CALENDAR DATE (`YYYY-MM-DD`), never an instant. They are read with `Date.UTC` and `getUTC*`, so the machine's own
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

/** A real calendar day as `YYYY-MM-DD` (not 2026-02-30). */
export const isCalendarDay = (value: string): boolean => {
  const match = DATE_PATTERN.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const at = new Date(Date.UTC(year, month - 1, day));
  return at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day;
};

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

/** A chosen period as the sheet and the PDF Layout print it: "Thu 1 Oct 2026 – Wed 28 Oct 2026". */
export const formatPeriod = (from: string, to: string): string =>
  from === to ? formatDayAndDate(from) : `${formatDayAndDate(from)} – ${formatDayAndDate(to)}`;

/**
 * The range the timesheet page opens on: the first of the current month to
 * today. Every visit starts here — the filters are not remembered — and that
 * reset touches only the two filter boxes, never a saved line.
 */
export const defaultTimesheetRange = (today: string): { readonly from: string; readonly to: string } => ({
  from: `${today.slice(0, 7)}-01`,
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

/**
 * Why the date typed on a timesheet LINE cannot be saved, or null when it can.
 *
 * Asked while the technician types, because a date field reports an EMPTY
 * value whenever any part of the date is cleared or retyped, and in-between
 * dates as digits arrive. Those are states of typing, not answers: the form
 * stays where it was opened and says what is wrong, rather than acting on
 * them (the 30 October 2026 freeze — see the timesheets page). The server asks
 * its own questions again on Save.
 */
export const lineDateProblem = (date: string, from: string, to: string, today: string): string | null => {
  if (!isCalendarDay(date)) return 'Enter the whole date (day, month and year).';
  if (date > today) return 'That day has not happened yet.';
  if (date < from || date > to) return `Choose a day in this timesheet: ${formatPeriod(from, to)}.`;
  return null;
};
