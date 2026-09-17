import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  endOfMonth,
  monthRowDensity,
  packWeek,
  rangeOfDays,
  startOfMonth,
  startOfWeek,
  viewLabel,
  viewRange,
} from './calendar-grid';
import type { CalendarEntry } from '@/application/calendar';

/**
 * Calendar geometry.
 *
 * The part most likely to be quietly wrong: week boundaries, month grids that
 * spill into neighbouring months, and multi-day bars that have to be clipped and
 * marked as continuing on both rows.
 */
const entry = (id: string, start: string, end: string): CalendarEntry => ({
  kind: 'availability',
  id,
  start,
  end,
  days: rangeOfDays(start, end).length,
  title: id,
  subtitle: '',
  availabilityType: 'annual_leave',
  availabilityStatus: 'active',
  userId: 'u1',
  userName: 'Tester',
  userInitials: 'TT',
  blocking: true,
  allDay: true,
  timeLabel: 'All day',
  description: '',
});

describe('date arithmetic', () => {
  it('starts the week on Monday', () => {
    // 2026-09-17 is a Thursday.
    expect(startOfWeek('2026-09-17')).toBe('2026-09-14');
    expect(startOfWeek('2026-09-14')).toBe('2026-09-14');
    expect(startOfWeek('2026-09-20')).toBe('2026-09-14');
  });

  it('crosses month and year boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('finds month bounds, including February in a leap year', () => {
    expect(startOfMonth('2026-09-17')).toBe('2026-09-01');
    expect(endOfMonth('2026-09-17')).toBe('2026-09-30');
    expect(endOfMonth('2024-02-10')).toBe('2024-02-29');
    expect(endOfMonth('2026-02-10')).toBe('2026-02-28');
  });

  it('adds months without rolling over a short month', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-01');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-01');
  });
});

describe('viewRange', () => {
  it('covers a single day for the day view', () => {
    expect(viewRange('day', '2026-09-17')).toEqual({ from: '2026-09-17', to: '2026-09-17' });
  });

  it('covers Monday to Sunday for the week view', () => {
    expect(viewRange('week', '2026-09-17')).toEqual({ from: '2026-09-14', to: '2026-09-20' });
  });

  it('pads the month grid to whole weeks', () => {
    const range = viewRange('month', '2026-09-17');
    // September 2026 starts on a Tuesday, so the grid starts on 31 August.
    expect(range.from).toBe('2026-08-31');
    expect(rangeOfDays(range.from, range.to).length % 7).toBe(0);
  });

  it('covers the whole year for the year view', () => {
    expect(viewRange('year', '2026-09-17')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  });
});

describe('packWeek', () => {
  const weekStart = '2026-09-14'; // Monday

  it('places a single-day entry in the right column', () => {
    const [placed] = packWeek([entry('a', '2026-09-16', '2026-09-16')], weekStart);
    expect(placed?.offset).toBe(2);
    expect(placed?.span).toBe(1);
    expect(placed?.continuesBefore).toBe(false);
    expect(placed?.continuesAfter).toBe(false);
  });

  it('spans a multi-day entry across the right number of columns', () => {
    const [placed] = packWeek([entry('a', '2026-09-15', '2026-09-18')], weekStart);
    expect(placed?.offset).toBe(1);
    expect(placed?.span).toBe(4);
  });

  it('clips an entry that starts before the row and marks it as continuing', () => {
    const [placed] = packWeek([entry('a', '2026-09-10', '2026-09-16')], weekStart);
    expect(placed?.offset).toBe(0);
    expect(placed?.span).toBe(3);
    expect(placed?.continuesBefore).toBe(true);
    expect(placed?.continuesAfter).toBe(false);
  });

  it('clips an entry that runs past the row', () => {
    const [placed] = packWeek([entry('a', '2026-09-18', '2026-09-25')], weekStart);
    expect(placed?.offset).toBe(4);
    expect(placed?.span).toBe(3);
    expect(placed?.continuesAfter).toBe(true);
  });

  it('marks an entry that spans the whole row on both sides', () => {
    const [placed] = packWeek([entry('a', '2026-09-01', '2026-09-30')], weekStart);
    expect(placed?.span).toBe(7);
    expect(placed?.continuesBefore).toBe(true);
    expect(placed?.continuesAfter).toBe(true);
  });

  it('puts overlapping entries in separate lanes', () => {
    const packed = packWeek(
      [entry('a', '2026-09-14', '2026-09-17'), entry('b', '2026-09-15', '2026-09-18')],
      weekStart,
    );
    expect(packed.map((placed) => placed.lane)).toEqual([0, 1]);
  });

  it('reuses a lane once the previous entry in it has ended', () => {
    const packed = packWeek(
      [entry('a', '2026-09-14', '2026-09-15'), entry('b', '2026-09-17', '2026-09-18')],
      weekStart,
    );
    expect(packed.every((placed) => placed.lane === 0)).toBe(true);
  });

  it('ignores entries outside the row entirely', () => {
    expect(packWeek([entry('a', '2026-10-01', '2026-10-05')], weekStart)).toHaveLength(0);
  });
});

describe('viewLabel', () => {
  it('describes each period', () => {
    expect(viewLabel('day', '2026-09-17')).toBe('17 September 2026');
    expect(viewLabel('week', '2026-09-17')).toBe('14 Sep – 20 Sep 2026');
    expect(viewLabel('month', '2026-09-17')).toBe('September 2026');
    expect(viewLabel('year', '2026-09-17')).toBe('2026');
  });
});

/* -------------------------------------------------------------------------- */
/* Month density                                                              */
/* -------------------------------------------------------------------------- */

const job = (id: string, start: string, end: string): CalendarEntry => ({
  kind: 'job',
  id,
  start,
  end,
  days: rangeOfDays(start, end).length,
  title: id,
  subtitle: '',
  jobNumber: id,
  jobType: 'breakdown',
  status: 'open',
  priority: 'normal',
  customerName: 'Test Customer',
  siteName: 'Test Site',
  machineLabel: 'Test Machine',
  technicianIds: ['u1'],
  technicianNames: ['Tester'],
  technicianInitials: ['TT'],
});

describe('monthRowDensity', () => {
  const weekStart = '2026-09-14'; // Monday
  const busyDay = '2026-09-16';

  it('shows everything on a quiet day and offers no "+N more"', () => {
    const density = monthRowDensity(
      [job('EJE-1001', busyDay, busyDay), job('EJE-1002', busyDay, busyDay)],
      weekStart,
    );
    expect(density.visible).toHaveLength(2);
    expect(density.hasHidden).toBe(false);
    expect(density.hiddenByDay).toEqual({});
  });

  it('caps a busy day at three bars and defers the rest', () => {
    const density = monthRowDensity(
      Array.from({ length: 7 }, (_, index) => job(`EJE-10${index}`, busyDay, busyDay)),
      weekStart,
    );

    expect(density.visible).toHaveLength(3);
    expect(density.lanes).toBe(3);
    // Nothing is dropped: the four not drawn are counted for the affordance.
    expect(density.hiddenByDay[busyDay]).toBe(4);
    expect(density.hasHidden).toBe(true);
  });

  it('counts hidden entries per day, not per row', () => {
    const density = monthRowDensity(
      [
        ...Array.from({ length: 5 }, (_, index) => job(`EJE-a${index}`, busyDay, busyDay)),
        job('EJE-b0', '2026-09-18', '2026-09-18'),
      ],
      weekStart,
    );

    expect(density.hiddenByDay[busyDay]).toBe(2);
    // The quiet day's single entry is in a free lane, so nothing is hidden.
    expect(density.hiddenByDay['2026-09-18']).toBeUndefined();
  });

  it('keeps a multi-day bar whole rather than counting it per day', () => {
    const density = monthRowDensity([job('EJE-1053', '2026-09-15', '2026-09-18')], weekStart);
    const [placed] = density.visible;

    expect(density.visible).toHaveLength(1);
    expect(placed?.span).toBe(4);
    expect(density.hasHidden).toBe(false);
  });

  it('counts a multi-day bar as hidden on every day it covers', () => {
    const density = monthRowDensity(
      [
        job('EJE-a', '2026-09-14', '2026-09-20'),
        job('EJE-b', '2026-09-14', '2026-09-20'),
        job('EJE-c', '2026-09-14', '2026-09-20'),
        // Overlaps the whole row, so it lands in a fourth lane and is deferred.
        job('EJE-d', '2026-09-15', '2026-09-17'),
      ],
      weekStart,
    );

    expect(density.visible).toHaveLength(3);
    expect(density.hiddenByDay['2026-09-15']).toBe(1);
    expect(density.hiddenByDay['2026-09-17']).toBe(1);
    expect(density.hiddenByDay['2026-09-18']).toBeUndefined();
  });

  it('gives work the upper lanes and availability the lower ones', () => {
    const density = monthRowDensity(
      [
        entry('leave-1', busyDay, busyDay),
        job('EJE-1001', busyDay, busyDay),
        entry('leave-2', busyDay, busyDay),
        job('EJE-1002', busyDay, busyDay),
      ],
      weekStart,
    );

    // A planner scans a month grid for jobs first, so on a busy day it is the
    // absence rows that fall behind "+N more" rather than a job.
    expect(density.visible.map((placed) => placed.entry.kind)).toEqual([
      'job',
      'job',
      'availability',
    ]);
    expect(density.hiddenByDay[busyDay]).toBe(1);
  });

  it('never hides a job in favour of an absence', () => {
    const density = monthRowDensity(
      [
        ...Array.from({ length: 3 }, (_, index) => entry(`leave-${index}`, busyDay, busyDay)),
        job('EJE-1001', busyDay, busyDay),
      ],
      weekStart,
    );

    expect(density.visible[0]?.entry.kind).toBe('job');
    expect(density.visible.filter((placed) => placed.entry.kind === 'job')).toHaveLength(1);
  });

  it('honours a different lane cap, so the rule is not hard-coded to the view', () => {
    const entries = Array.from({ length: 6 }, (_, index) =>
      job(`EJE-10${index}`, busyDay, busyDay),
    );
    expect(monthRowDensity(entries, weekStart, 5).visible).toHaveLength(5);
    expect(monthRowDensity(entries, weekStart, 5).hiddenByDay[busyDay]).toBe(1);
  });
});
