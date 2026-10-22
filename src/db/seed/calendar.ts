import type { IsoDate, IsoDateTime } from '@/domain';
import { BUSINESS_UTC_OFFSET_MINUTES, businessDateOf, businessToday } from '@/lib/business-time';

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
/*
 * "TODAY" IS THE BUSINESS DAY, NOT THE RUNNER'S DAY. QA-5.
 *
 * `new Date().getDate()` is the LOCAL date of whatever machine runs the seed —
 * UTC on the server and on CI — while everything that reads the data back asks
 * in the business zone. The two disagree between 22:00 and midnight UTC, and
 * for those two hours a day the seeded availability, the scheduled jobs and the
 * dashboard tiles were all a day out. See the same note in
 * `src/data/seed/reference.ts`, which carried the identical defect.
 */
const businessComponents = (): readonly [number, number, number] => {
  const [year, month, day] = businessToday().split('-').map(Number);
  return [year ?? 1970, month ?? 1, day ?? 1];
};

export const toIsoDate = (date: Date): IsoDate =>
  businessDateOf(date.toISOString()) ?? '1970-01-01';

/** A calendar date offset from today. Negative is the past. */
export const dayOffset = (days: number): IsoDate => {
  const [year, month, day] = businessComponents();
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10) as IsoDate;
};

/** A timestamp at a given hour ON EJE'S CLOCK, on a day offset from today. */
export const timeOffset = (days: number, hours: number, minutes = 0): IsoDateTime => {
  const [year, month, day] = businessComponents();
  const instant =
    Date.UTC(year, month - 1, day + days, hours, minutes) -
    BUSINESS_UTC_OFFSET_MINUTES * 60_000;
  return new Date(instant).toISOString();
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
  const [year, month, day] = businessComponents();
  const base = new Date(Date.UTC(year, month - 1, day));
  const untilMonday = (8 - base.getUTCDay()) % 7 || 7;
  base.setUTCDate(base.getUTCDate() + untilMonday + addDays);
  return base.toISOString().slice(0, 10) as IsoDate;
};
