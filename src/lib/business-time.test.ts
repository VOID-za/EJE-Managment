import { afterEach, describe, expect, it } from 'vitest';
import {
  BUSINESS_TIME_ZONE,
  BUSINESS_UTC_OFFSET_MINUTES,
  businessDateOf,
  businessParts,
  businessToday,
} from './business-time';
import { formatDate, formatDateTime, formatTime, isOverdue, isToday } from './format';

/**
 * The date on a document must not depend on the machine that rendered it.
 *
 * The bug these hold against: timestamps are stored in UTC and used to be read
 * with LOCAL `Date` getters, so `2026-09-19T23:30:00.000Z` printed "19 Sep 2026
 * 23:30" on a UTC server and "20 Sep 2026 01:30" on a South African tablet —
 * two different calendar dates, from one stored instant, on a document a
 * customer signs. Phase 2 renders documents server-side, very probably on UTC.
 *
 * So the assertion that matters is not "this is the right string" but "this is
 * the SAME string under either zone", and that is what is run below: each case
 * is executed twice, with `process.env.TZ` set to UTC and then to
 * Africa/Johannesburg, and the two results must be identical.
 */

const originalTimeZone = process.env.TZ;

afterEach(() => {
  if (originalTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimeZone;
});

/**
 * Runs `produce` under a given zone.
 *
 * Node reads `process.env.TZ` when it constructs a `Date`, so setting it here
 * genuinely changes what the local getters would return — which is precisely
 * what must stop mattering.
 */
const under = <T>(timeZone: string, produce: () => T): T => {
  process.env.TZ = timeZone;
  try {
    return produce();
  } finally {
    if (originalTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimeZone;
  }
};

/** The same computation under both zones, which must agree. */
const inBothZones = <T>(produce: () => T): { utc: T; sast: T } => ({
  utc: under('UTC', produce),
  sast: under('Africa/Johannesburg', produce),
});

describe('the business zone', () => {
  it('is South African Standard Time, named and offset in one place', () => {
    expect(BUSINESS_TIME_ZONE).toBe('Africa/Johannesburg');
    expect(BUSINESS_UTC_OFFSET_MINUTES).toBe(120);
  });

  it('reads a UTC instant as the South African wall clock', () => {
    const parts = businessParts('2026-09-19T23:30:00.000Z');
    expect(parts).toEqual({
      year: 2026,
      month: 9,
      day: 20,
      hours: 1,
      minutes: 30,
      dateOnly: false,
    });
  });

  it('leaves a calendar date exactly as it was chosen', () => {
    // A scheduled day is a date somebody picked, not an instant. Shifting it by
    // an offset would invent a time it never had, and could move it a day.
    expect(businessParts('2026-09-19')).toEqual({
      year: 2026,
      month: 9,
      day: 19,
      hours: 0,
      minutes: 0,
      dateOnly: true,
    });
    expect(businessDateOf('2026-09-19')).toBe('2026-09-19');
  });

  it('answers "which day did this happen on" in EJE terms', () => {
    // 23:30 UTC is already tomorrow in Johannesburg, and the business date says so.
    expect(businessDateOf('2026-09-19T23:30:00.000Z')).toBe('2026-09-20');
    // 21:59 UTC is still the same day.
    expect(businessDateOf('2026-09-19T21:59:00.000Z')).toBe('2026-09-19');
  });

  it('returns null for anything it cannot read, rather than NaN', () => {
    expect(businessParts('not a date')).toBeNull();
    expect(businessParts('2026-13-99')).toBeNull();
  });
});

describe('the same instant, rendered under two time zones', () => {
  const instants = [
    // The boundary case: late evening UTC is the next morning in South Africa.
    '2026-09-19T23:30:00.000Z',
    // And the mirror: early morning SAST is the previous evening in UTC.
    '2026-09-20T00:15:00.000Z',
    '2026-01-01T22:05:00.000Z',
    '2026-06-30T12:00:00.000Z',
  ];

  for (const instant of instants) {
    it(`formats ${instant} identically`, () => {
      const dates = inBothZones(() => formatDate(instant));
      const times = inBothZones(() => formatTime(instant));
      const stamps = inBothZones(() => formatDateTime(instant));

      expect(dates.utc).toBe(dates.sast);
      expect(times.utc).toBe(times.sast);
      expect(stamps.utc).toBe(stamps.sast);
    });
  }

  it('prints the South African wall clock, not the runtime’s', () => {
    const stamps = inBothZones(() => formatDateTime('2026-09-19T23:30:00.000Z'));
    // Not "19 Sep 2026 23:30", which is what a UTC server used to print.
    expect(stamps.utc).toBe('20 Sep 2026 01:30');
    expect(stamps.sast).toBe('20 Sep 2026 01:30');
  });

  it('renders a calendar date identically too', () => {
    const rendered = inBothZones(() => formatDate('2026-09-07'));
    expect(rendered.utc).toBe('07 Sep 2026');
    expect(rendered.sast).toBe('07 Sep 2026');
  });
});

describe('"today", in EJE terms', () => {
  it('is the business calendar date, whatever the runtime thinks', () => {
    const days = inBothZones(() => businessToday(new Date('2026-09-19T23:30:00.000Z')));
    expect(days.utc).toBe('2026-09-20');
    expect(days.sast).toBe('2026-09-20');
  });

  it('decides overdue and today against that same date', () => {
    const today = businessToday();
    expect(isToday(today)).toBe(true);
    expect(isOverdue(today)).toBe(false);

    const yesterday = businessDateOf(
      new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString(),
    );
    expect(isOverdue(yesterday)).toBe(true);
  });

  it('agrees with itself under either zone', () => {
    const answers = inBothZones(() => {
      const today = businessToday();
      return `${today}|${isToday(today)}|${isOverdue(today)}`;
    });
    expect(answers.utc).toBe(answers.sast);
  });
});
