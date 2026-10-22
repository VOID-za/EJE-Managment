import { afterEach, describe, expect, it, vi } from 'vitest';
import { businessToday } from '@/lib/business-time';
import { dateOffset, nextMonday, timeOffset } from './reference';
import { dayOffset, timeOffset as dbTimeOffset, nextMonday as dbNextMonday } from '@/db/seed/calendar';

/**
 * THE SEED'S "TODAY" MUST BE EJE'S TODAY. QA-5, found a third time.
 *
 * Both seeds built their dates from `new Date().getDate()` — the LOCAL date of
 * whatever machine runs them, which is UTC on the server and on CI. Everything
 * that reads the data back asks in the business zone. Between 22:00 and
 * midnight UTC, which is midnight to 02:00 in Johannesburg, the two disagreed
 * by a day, and for those two hours:
 *
 *   - the seeded part-day appointment was on YESTERDAY, so the calendar's day
 *     view had nothing to show and the conflict panel had no window to name;
 *   - "Today's scheduled jobs" was a day out;
 *   - a technician recorded as on sick leave today was not, so an assignment
 *     the demonstration exists to refuse was allowed.
 *
 * THE INSTANT BELOW IS THE DEFECT'S OWN WINDOW. 22:30 UTC on 21 October is
 * 00:30 on 22 October in Johannesburg: the business day is the 22nd, and the
 * old code said the 21st. Nothing here depends on when the suite is run.
 */
const INSIDE_THE_WINDOW = new Date('2026-10-21T22:30:00.000Z');

describe('seed dates during the two hours the zones disagree', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const at = (instant: Date): void => {
    vi.useFakeTimers();
    vi.setSystemTime(instant);
  };

  it('is the BUSINESS day, which is already tomorrow', () => {
    at(INSIDE_THE_WINDOW);

    // The fact every assertion below is about: EJE are in a new day already.
    expect(businessToday()).toBe('2026-10-22');
    expect(dateOffset(0)).toBe('2026-10-22');
    expect(dayOffset(0)).toBe('2026-10-22');
  });

  it('offsets from that day and not from the runner’s', () => {
    at(INSIDE_THE_WINDOW);

    expect(dateOffset(-1)).toBe('2026-10-21');
    expect(dateOffset(1)).toBe('2026-10-23');
    // Across a month boundary, where naive arithmetic also goes wrong.
    expect(dateOffset(10)).toBe('2026-11-01');
    expect(dayOffset(-1)).toBe('2026-10-21');
    expect(dayOffset(10)).toBe('2026-11-01');
  });

  it('reads an hour given to it as an hour on EJE’s clock', () => {
    at(INSIDE_THE_WINDOW);

    /*
     * 09:00 in Johannesburg is 07:00 UTC, on the business day — so the
     * appointment the calendar renders as 09:00–11:00 is stored as the instant
     * EJE would call nine in the morning, whatever the server's own zone is.
     */
    expect(timeOffset(0, 9)).toBe('2026-10-22T07:00:00.000Z');
    expect(dbTimeOffset(0, 9)).toBe('2026-10-22T07:00:00.000Z');
    expect(timeOffset(0, 9, 30)).toBe('2026-10-22T07:30:00.000Z');
    // And an hour before EJE's midnight is the previous UTC day, correctly.
    expect(timeOffset(0, 1)).toBe('2026-10-21T23:00:00.000Z');
  });

  it('anchors a Monday to the business week', () => {
    at(INSIDE_THE_WINDOW);

    // 22 October 2026 is a Thursday, so the next Monday is the 26th.
    expect(nextMonday()).toBe('2026-10-26');
    expect(dbNextMonday()).toBe('2026-10-26');
    expect(nextMonday(1)).toBe('2026-10-27');
    expect(nextMonday(0, 1)).toBe('2026-11-02');
  });

  it('still agrees with the business date outside the window', () => {
    // The ordinary case, which the old code got right and this must not break.
    at(new Date('2026-10-22T09:00:00.000Z'));

    expect(dateOffset(0)).toBe('2026-10-22');
    expect(dayOffset(0)).toBe('2026-10-22');
    expect(timeOffset(0, 9)).toBe('2026-10-22T07:00:00.000Z');
  });

  it('is right on the far side of midnight UTC too', () => {
    // 00:30 UTC on the 22nd is 02:30 the same day in Johannesburg: both agree,
    // and the hour must not slide into the previous day.
    at(new Date('2026-10-22T00:30:00.000Z'));

    expect(dateOffset(0)).toBe('2026-10-22');
    expect(timeOffset(0, 9)).toBe('2026-10-22T07:00:00.000Z');
  });
});
