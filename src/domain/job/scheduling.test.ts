import { describe, expect, it } from 'vitest';
import {
  checkSchedule,
  daysBetween,
  isMultiDay,
  jobScheduleWindow,
  jobScheduledDates,
  jobSchedulesRange,
  schedulesOverlap,
} from './scheduling';

/**
 * Service work is quoted for a number of days, so a service job occupies a
 * calendar RANGE. Every other job type is a single visit.
 */
const job = (jobType: 'service' | 'breakdown', start: string | null, end: string | null) => ({
  jobType: jobType as never,
  scheduledDate: start,
  scheduledEndDate: end,
});

describe('which job types schedule a range', () => {
  it('is service only', () => {
    expect(jobSchedulesRange('service')).toBe(true);
    expect(jobSchedulesRange('breakdown')).toBe(false);
    expect(jobSchedulesRange('installation')).toBe(false);
    expect(jobSchedulesRange('test_and_repair')).toBe(false);
  });
});

describe('jobScheduleWindow', () => {
  it('returns null for an unscheduled job', () => {
    expect(jobScheduleWindow(job('service', null, null))).toBeNull();
  });

  it('is a single day for a breakdown', () => {
    const window = jobScheduleWindow(job('breakdown', '2026-09-17', null));
    expect(window).toEqual({ start: '2026-09-17', end: '2026-09-17', days: 1 });
  });

  it('is a single day for a service with no end date', () => {
    expect(jobScheduleWindow(job('service', '2026-09-17', null))?.days).toBe(1);
  });

  it('spans the full range for a multi-day service', () => {
    const window = jobScheduleWindow(job('service', '2026-09-17', '2026-09-21'));
    expect(window).toEqual({ start: '2026-09-17', end: '2026-09-21', days: 5 });
  });

  it('ignores an end date on a job type that does not schedule ranges', () => {
    const window = jobScheduleWindow(job('breakdown', '2026-09-17', '2026-09-25'));
    expect(window?.days).toBe(1);
  });

  it('clamps a corrupt range rather than rendering a negative bar', () => {
    expect(jobScheduleWindow(job('service', '2026-09-20', '2026-09-17'))?.days).toBe(1);
  });

  it('spans a month boundary correctly', () => {
    expect(jobScheduleWindow(job('service', '2026-09-29', '2026-10-02'))?.days).toBe(4);
  });
});

describe('jobScheduledDates', () => {
  it('lists every day a multi-day service occupies', () => {
    expect(jobScheduledDates(job('service', '2026-09-29', '2026-10-01'))).toEqual([
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
    ]);
  });

  it('is empty for an unscheduled job', () => {
    expect(jobScheduledDates(job('service', null, null))).toEqual([]);
  });

  it('identifies multi-day work', () => {
    expect(isMultiDay(job('service', '2026-09-17', '2026-09-19'))).toBe(true);
    expect(isMultiDay(job('service', '2026-09-17', '2026-09-17'))).toBe(false);
    expect(isMultiDay(job('breakdown', '2026-09-17', null))).toBe(false);
  });
});

describe('checkSchedule', () => {
  it('accepts a valid service range', () => {
    expect(checkSchedule('service', '2026-09-17', '2026-09-21')).toEqual([]);
  });

  it('accepts a service with no end date', () => {
    expect(checkSchedule('service', '2026-09-17', null)).toEqual([]);
  });

  it('accepts a single-day service where start equals end', () => {
    expect(checkSchedule('service', '2026-09-17', '2026-09-17')).toEqual([]);
  });

  it('REJECTS an end date before the start date', () => {
    const violations = checkSchedule('service', '2026-09-21', '2026-09-17');
    expect(violations).toHaveLength(1);
    expect(violations[0]?.code).toBe('end_before_start');
  });

  it('rejects an end date with no start date', () => {
    expect(checkSchedule('service', null, '2026-09-21')[0]?.code).toBe('end_without_start');
  });

  it('does not police dates on job types that do not schedule a range', () => {
    expect(checkSchedule('breakdown', '2026-09-21', '2026-09-17')).toEqual([]);
  });
});

describe('daysBetween and overlap', () => {
  it('counts whole days across a month boundary', () => {
    expect(daysBetween('2026-09-29', '2026-10-01')).toBe(2);
    expect(daysBetween('2026-09-17', '2026-09-17')).toBe(0);
    expect(daysBetween('2026-09-20', '2026-09-17')).toBe(-3);
  });

  it('detects overlapping bookings', () => {
    const a = job('service', '2026-09-17', '2026-09-21');
    expect(schedulesOverlap(a, job('breakdown', '2026-09-19', null))).toBe(true);
    expect(schedulesOverlap(a, job('breakdown', '2026-09-21', null))).toBe(true);
    expect(schedulesOverlap(a, job('breakdown', '2026-09-22', null))).toBe(false);
    expect(schedulesOverlap(a, job('service', null, null))).toBe(false);
  });
});
