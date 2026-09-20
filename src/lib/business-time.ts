import type { IsoDate, IsoDateTime } from '@/domain';

/**
 * EJE business time.
 *
 * Every timestamp in the system is stored in UTC — `SystemClock.now()` returns
 * `new Date().toISOString()` and nothing here changes that. What this module
 * fixes is READING one: a UTC instant has to be presented as the calendar date
 * and clock time EJE was working at when it happened, and that answer must not
 * depend on the machine doing the rendering.
 *
 * It did. `new Date(value).getDate()` is the LOCAL date of whatever runtime is
 * executing, so `2026-09-19T23:30:00.000Z` printed as "19 Sep 2026 23:30" on a
 * UTC server and "20 Sep 2026 01:30" on a South African tablet. That is a
 * different calendar date on a document a customer signs, produced from the
 * same stored instant, and Phase 2 renders documents server-side — very
 * probably on a UTC host.
 *
 * So the whole system reads instants in ONE zone, named once, here.
 *
 * WHY A FIXED OFFSET AND NOT `Intl`: South Africa has observed UTC+02:00
 * continuously since 1903 and keeps no daylight saving, so the offset IS the
 * zone — there is no rule to look up and nothing to get wrong. `Intl` would
 * also reintroduce exactly the hazard `format.ts` avoids it for: the ICU data
 * bundled with Node and with Chromium disagree, so the same instant could
 * render differently in the server build and the browser.
 */

/** The zone EJE works in. Named so the constant below is never a mystery. */
export const BUSINESS_TIME_ZONE = 'Africa/Johannesburg';

/**
 * South African Standard Time, UTC+02:00, all year.
 *
 * If EJE ever operates from a zone that observes daylight saving, this constant
 * stops being sufficient and the conversion below has to consult a zone
 * database. That is the whole change, and it is in one place.
 */
export const BUSINESS_UTC_OFFSET_MINUTES = 120;

export interface BusinessDateTimeParts {
  readonly year: number;
  /** 1–12, as people count months rather than as `Date` does. */
  readonly month: number;
  readonly day: number;
  readonly hours: number;
  readonly minutes: number;
  /** True when the value carried no time of day, so there is no clock to show. */
  readonly dateOnly: boolean;
}

/** A plain `YYYY-MM-DD` with no time of day. */
const isDateOnly = (value: string): boolean => value.length === 10;

/**
 * Splits a stored value into the business-zone parts a formatter prints.
 *
 * Returns null for anything unparseable, so callers render their own placeholder
 * rather than "Invalid Date" or, worse, NaN.
 *
 * A DATE-ONLY value is read literally. `2026-09-19` is a calendar date that
 * somebody chose — a scheduled day, a labour date — not an instant, so shifting
 * it by an offset would be inventing a time it never had and could move it a day.
 */
export const businessParts = (
  value: IsoDate | IsoDateTime,
): BusinessDateTimeParts | null => {
  if (isDateOnly(value)) {
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return { year, month, day, hours: 0, minutes: 0, dateOnly: true };
  }

  const instant = new Date(value);
  const epoch = instant.getTime();
  if (Number.isNaN(epoch)) return null;

  /*
   * Shifted, then read with the UTC getters.
   *
   * Adding the offset to the epoch and reading in UTC is the whole conversion:
   * the UTC getters are the only ones that behave identically in every runtime,
   * so the result depends on the stored instant and on `BUSINESS_UTC_OFFSET_MINUTES`
   * and on nothing else.
   */
  const shifted = new Date(epoch + BUSINESS_UTC_OFFSET_MINUTES * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hours: shifted.getUTCHours(),
    minutes: shifted.getUTCMinutes(),
    dateOnly: false,
  };
};

/**
 * The calendar date, in the business zone, as `YYYY-MM-DD`.
 *
 * What "which day did this happen on?" means for anything EJE reports on.
 */
export const businessDateOf = (value: IsoDate | IsoDateTime): IsoDate | null => {
  const parts = businessParts(value);
  if (parts === null) return null;
  const month = `${parts.month}`.padStart(2, '0');
  const day = `${parts.day}`.padStart(2, '0');
  return `${parts.year}-${month}-${day}`;
};

/** Today's calendar date in the business zone. */
export const businessToday = (now: Date = new Date()): IsoDate =>
  businessDateOf(now.toISOString()) ?? '1970-01-01';
