import { describe, expect, it } from 'vitest';
import { entriesOn, findConflicts, loadCalendar } from './calendar';
import { createDemoRepositories } from '@/data/demo/repositories';
import { DemoStore } from '@/data/demo/demo-store';
import { rangeOfDays, toIso } from '@/components/calendar/calendar-grid';
import type { RepositoryBundle } from '@/data/repositories';

/**
 * Calendar assembly.
 *
 * Verified against the real seeded repositories rather than fixtures, because
 * the point of the calendar is that it reflects the actual schedule.
 */
const buildRepos = (): RepositoryBundle => {
  const store = new DemoStore();
  return createDemoRepositories({ read: store.read, commit: store.commit });
};

const today = toIso(new Date());
const offset = (days: number): string => {
  const date = new Date(`${today}T00:00:00`);
  date.setDate(date.getDate() + days);
  return toIso(date);
};

const wideRange = { from: offset(-60), to: offset(60) };

describe('loadCalendar', () => {
  it('includes scheduled jobs', async () => {
    const data = await loadCalendar(buildRepos(), wideRange);
    const jobs = data.entries.filter((entry) => entry.kind === 'job');

    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.some((entry) => entry.kind === 'job' && entry.jobNumber === 'EJE-1048')).toBe(
      true,
    );
  });

  it('includes technician leave', async () => {
    const data = await loadCalendar(buildRepos(), wideRange);
    const leave = data.entries.filter((entry) => entry.kind === 'leave');

    expect(leave.length).toBeGreaterThan(0);
    expect(leave.some((entry) => entry.kind === 'leave' && entry.leaveType === 'annual')).toBe(
      true,
    );
  });

  it('includes sick leave specifically', async () => {
    const data = await loadCalendar(buildRepos(), wideRange);
    const sick = data.entries.filter(
      (entry) => entry.kind === 'leave' && entry.leaveType === 'sick',
    );
    expect(sick.length).toBeGreaterThan(0);
  });

  it('spans a multi-day service job across its whole booking', async () => {
    const data = await loadCalendar(buildRepos(), wideRange);
    const service = data.entries.find(
      (entry) => entry.kind === 'job' && entry.jobNumber === 'EJE-1049',
    );

    expect(service).toBeDefined();
    expect(service!.days).toBeGreaterThan(1);
    expect(service!.end > service!.start).toBe(true);
  });

  it('keeps single-day jobs to one day', async () => {
    const data = await loadCalendar(buildRepos(), wideRange);
    const breakdown = data.entries.find(
      (entry) => entry.kind === 'job' && entry.jobNumber === 'EJE-1048',
    );
    expect(breakdown?.days).toBe(1);
  });

  it('excludes jobs with no scheduled date', async () => {
    const repos = buildRepos();
    const data = await loadCalendar(repos, wideRange);
    const jobs = await repos.jobs.list();

    const unscheduled = jobs.filter((job) => job.scheduledDate === null);
    for (const job of unscheduled) {
      expect(data.entries.some((entry) => entry.id === `job-${job.id}`)).toBe(false);
    }
  });

  it('only returns entries overlapping the requested window', async () => {
    const narrow = { from: offset(3), to: offset(5) };
    const data = await loadCalendar(buildRepos(), narrow);

    for (const entry of data.entries) {
      expect(entry.start <= narrow.to).toBe(true);
      expect(entry.end >= narrow.from).toBe(true);
    }
  });

  it('includes an entry that starts before the window but runs into it', async () => {
    const repos = buildRepos();
    // The seeded sick leave straddles today.
    const data = await loadCalendar(repos, { from: today, to: today });
    const straddling = data.entries.filter((entry) => entry.start < today);
    expect(straddling.length).toBeGreaterThan(0);
  });

  it('carries the technicians assigned to a job', async () => {
    const data = await loadCalendar(buildRepos(), wideRange);
    const withTechnicians = data.entries.find(
      (entry) => entry.kind === 'job' && entry.technicianIds.length > 0,
    );
    expect(withTechnicians).toBeDefined();
  });

  it('returns the active technicians for filtering', async () => {
    const data = await loadCalendar(buildRepos(), wideRange);
    expect(data.technicians.length).toBeGreaterThan(0);
    expect(data.technicians.every((user) => user.role === 'technician' && user.active)).toBe(true);
  });

  it('sorts longest entries first so bars pack cleanly', async () => {
    const data = await loadCalendar(buildRepos(), wideRange);
    const lengths = data.entries.map((entry) => entry.days);
    expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
  });
});

describe('entriesOn', () => {
  it('returns every entry touching a day, including mid-range days', async () => {
    const data = await loadCalendar(buildRepos(), wideRange);
    const multiDay = data.entries.find((entry) => entry.days > 2);
    expect(multiDay).toBeDefined();

    const middle = rangeOfDays(multiDay!.start, multiDay!.end)[1]!;
    expect(entriesOn(data.entries, middle).some((entry) => entry.id === multiDay!.id)).toBe(true);
  });
});

describe('findConflicts', () => {
  it('flags a technician booked on a job while on approved leave', () => {
    const conflicts = findConflicts(
      [
        {
          kind: 'job',
          id: 'job-1',
          start: today,
          end: today,
          days: 1,
          title: 'EJE-9001',
          subtitle: '',
          jobNumber: 'EJE-9001',
          jobType: 'breakdown',
          status: 'open',
          priority: 'normal',
          customerName: 'Test',
          siteName: '',
          machineLabel: '',
          technicianIds: ['u1'],
          technicianNames: ['Tester'],
          technicianInitials: ['TT'],
        },
        {
          kind: 'leave',
          id: 'leave-1',
          start: today,
          end: today,
          days: 1,
          title: 'Tester',
          subtitle: 'Annual leave',
          leaveType: 'annual',
          leaveStatus: 'approved',
          userId: 'u1',
          userName: 'Tester',
          userInitials: 'TT',
          blocking: true,
          notes: '',
        },
      ],
      [today],
    );

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.technicianName).toBe('Tester');
  });

  it('does not flag a single job on a free day', () => {
    const conflicts = findConflicts(
      [
        {
          kind: 'job',
          id: 'job-1',
          start: today,
          end: today,
          days: 1,
          title: 'EJE-9001',
          subtitle: '',
          jobNumber: 'EJE-9001',
          jobType: 'breakdown',
          status: 'open',
          priority: 'normal',
          customerName: 'Test',
          siteName: '',
          machineLabel: '',
          technicianIds: ['u1'],
          technicianNames: ['Tester'],
          technicianInitials: ['TT'],
        },
      ],
      [today],
    );
    expect(conflicts).toHaveLength(0);
  });
});
