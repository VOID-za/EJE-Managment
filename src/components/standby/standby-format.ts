import { addStandbyDays, standbyWeekOf, type IsoDate } from '@/domain';

/**
 * Display helpers for the standby calendar. Calendar dates only — no time, no
 * zone — so a week never shifts a day on a device in another timezone.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export const shortDate = (date: IsoDate): string =>
  `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;

export const longDate = (date: IsoDate): string => `${shortDate(date)} ${date.slice(0, 4)}`;

/** "9 – 15 Nov 2026", "28 Dec 2026 – 3 Jan 2027". */
export const weekRangeLabel = (weekStart: IsoDate): string => {
  const end = addStandbyDays(weekStart, 6);
  if (weekStart.slice(0, 4) !== end.slice(0, 4)) return `${longDate(weekStart)} – ${longDate(end)}`;
  if (weekStart.slice(5, 7) !== end.slice(5, 7)) return `${shortDate(weekStart)} – ${longDate(end)}`;
  return `${Number(weekStart.slice(8, 10))} – ${longDate(end)}`;
};

export const monthLabel = (anchor: IsoDate): string =>
  `${LONG_MONTHS[Number(anchor.slice(5, 7)) - 1]} ${anchor.slice(0, 4)}`;

export const monthOf = (date: IsoDate): IsoDate => `${date.slice(0, 7)}-01`;

export const shiftMonth = (anchor: IsoDate, months: number): IsoDate => {
  const total = Number(anchor.slice(0, 4)) * 12 + Number(anchor.slice(5, 7)) - 1 + months;
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}-01`;
};

const lastDayOfMonth = (anchor: IsoDate): IsoDate => addStandbyDays(shiftMonth(anchor, 1), -1);

/** The weeks a month view shows: every week with at least one day in the month. */
export const monthWeekRange = (anchor: IsoDate): { from: IsoDate; to: IsoDate } => ({
  from: standbyWeekOf(monthOf(anchor)),
  to: lastDayOfMonth(monthOf(anchor)),
});

export const daysOfWeek = (weekStart: IsoDate): readonly IsoDate[] =>
  [0, 1, 2, 3, 4, 5, 6].map((offset) => addStandbyDays(weekStart, offset));
