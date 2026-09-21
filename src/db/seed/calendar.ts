import type { IsoDate, IsoDateTime } from '@/domain';

/**
 * Seed dates, relative to the day the seed is run.
 *
 * The same reasoning as the browser demonstration's own helpers: a dashboard
 * tile called "Today's scheduled jobs" has to have something in it whenever EJE
 * opens the application, not only on the afternoon the data was written.
 *
 * Deliberately a separate copy from `src/data/seed/reference.ts`. That module
 * belongs to the browser demonstration, whose dataset the existing test suites
 * assert against line by line; this one belongs to the database seed. Coupling
 * them would mean a change made for one silently rewrote the other.
 */
const startOfToday = (): Date => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
};

export const toIsoDate = (date: Date): IsoDate => {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/** A calendar date offset from today. Negative is the past. */
export const dayOffset = (days: number): IsoDate => {
  const date = startOfToday();
  date.setDate(date.getDate() + days);
  return toIsoDate(date);
};

/** A timestamp at a given hour on a day offset from today. */
export const timeOffset = (days: number, hours: number, minutes = 0): IsoDateTime => {
  const date = startOfToday();
  date.setDate(date.getDate() + days);
  date.setHours(hours, minutes, 0, 0);
  return date.toISOString();
};

/**
 * The same, for anything that must be in the PAST however early in the day the
 * seed is run. A conversation whose last message is in the future sorts above
 * one that has just been sent, and the wrong thread opens.
 */
export const timeAgo = (days: number, hours: number, minutes = 0): IsoDateTime => {
  const stamp = new Date(timeOffset(-Math.abs(days), hours, minutes));
  const now = new Date();
  return stamp.getTime() >= now.getTime()
    ? new Date(now.getTime() - 60 * 60 * 1000).toISOString()
    : stamp.toISOString();
};

export const minutesAgo = (minutes: number): IsoDateTime => {
  const date = new Date();
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() - minutes);
  return date.toISOString();
};

/**
 * The next Monday on or after today, plus an offset.
 *
 * Multi-day work is anchored to a Monday so a scheduled service renders as one
 * continuous bar in the calendar's month view rather than being split across a
 * week boundary — correct either way, but a poor first impression.
 */
export const nextMonday = (addDays = 0): IsoDate => {
  const date = startOfToday();
  const untilMonday = (8 - date.getDay()) % 7 || 7;
  date.setDate(date.getDate() + untilMonday + addDays);
  return toIsoDate(date);
};
