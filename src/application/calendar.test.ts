import { describe, expect, it } from 'vitest';
import { entriesOn, findConflicts, loadCalendar } from './calendar';
import { createDemoRepositories } from '@/data/demo/repositories';
import { DemoStore } from '@/data/demo/demo-store';
import { rangeOfDays, toIso } from '@/components/calendar/calendar-grid';
import type { RepositoryBundle } from '@/data/repositories';
import { asUserId, type User } from '@/domain';

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

/**
 * The office viewer these assertions are written from.
 *
 * `loadCalendar` now takes the person looking, because MASTER SCOPE §3.3 gives
 * technicians the calendar and DECISION 5 decides which jobs are theirs. These
 * cases are about ASSEMBLY — do jobs and absences come out as entries — so they
 * look with the role that sees everything. What each role sees is a different
 * question and is asserted in `calendar-access.test.ts`.
 */
const office: User = {
  id: asUserId('11111111-1111-4111-8111-111111111111'),
  firstName: 'Office',
  lastName: 'Viewer',
  initials: 'OV',
  email: 'office@eje-demo.local',
  mobile: '',
  role: 'master',
  jobTitle: 'Master',
  active: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('loadCalendar', () => {
  it('includes scheduled jobs', async () => {
    const data = await loadCalendar(buildRepos(), wideRange, office);
    const jobs = data.entries.filter((entry) => entry.kind === 'job');

    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.some((entry) => entry.kind === 'job' && entry.jobNumber === 'EJE-1048')).toBe(
      true,
    );
  });

  it('includes technician unavailability', async () => {
    const data = await loadCalendar(buildRepos(), wideRange, office);
    const absences = data.entries.filter((entry) => entry.kind === 'availability');

    expect(absences.length).toBeGreaterThan(0);
    expect(
      absences.some(
        (entry) => entry.kind === 'availability' && entry.availabilityType === 'annual_leave',
      ),
    ).toBe(true);
  });

  it('includes sick leave specifically', async () => {
    const data = await loadCalendar(buildRepos(), wideRange, office);
    const sick = data.entries.filter(
      (entry) => entry.kind === 'availability' && entry.availabilityType === 'sick_leave',
    );
    expect(sick.length).toBeGreaterThan(0);
  });

  it('carries the time window of a part-day absence, not just the date', async () => {
    const data = await loadCalendar(buildRepos(), wideRange, office);
    const appointment = data.entries.find(
      (entry) => entry.kind === 'availability' && entry.availabilityType === 'appointment',
    );

    expect(appointment?.kind).toBe('availability');
    if (appointment?.kind !== 'availability') throw new Error('no appointment seeded');
    expect(appointment.allDay).toBe(false);
    expect(appointment.timeLabel).toBe('09:00–11:00');
  });

  it('spans a multi-day service job across its whole booking', async () => {
    const data = await loadCalendar(buildRepos(), wideRange, office);
    const service = data.entries.find(
      (entry) => entry.kind === 'job' && entry.jobNumber === 'EJE-1049',
    );

    expect(service).toBeDefined();
    expect(service!.days).toBeGreaterThan(1);
    expect(service!.end > service!.start).toBe(true);
  });

  it('keeps single-day jobs to one day', async () => {
    const data = await loadCalendar(buildRepos(), wideRange, office);
    const breakdown = data.entries.find(
      (entry) => entry.kind === 'job' && entry.jobNumber === 'EJE-1048',
    );
    expect(breakdown?.days).toBe(1);
  });

  it('excludes jobs with no scheduled date', async () => {
    const repos = buildRepos();
    const data = await loadCalendar(repos, wideRange, office);
    const jobs = await repos.jobs.list();

    const unscheduled = jobs.filter((job) => job.scheduledDate === null);
    for (const job of unscheduled) {
      expect(data.entries.some((entry) => entry.id === `job-${job.id}`)).toBe(false);
    }
  });

  it('only returns entries overlapping the requested window', async () => {
    const narrow = { from: offset(3), to: offset(5) };
    const data = await loadCalendar(buildRepos(), narrow, office);

    for (const entry of data.entries) {
      expect(entry.start <= narrow.to).toBe(true);
      expect(entry.end >= narrow.from).toBe(true);
    }
  });

  it('includes an entry that starts before the window but runs into it', async () => {
    const repos = buildRepos();
    // The seeded sick leave straddles today.
    const data = await loadCalendar(repos, { from: today, to: today }, office);
    const straddling = data.entries.filter((entry) => entry.start < today);
    expect(straddling.length).toBeGreaterThan(0);
  });

  it('carries the technicians assigned to a job', async () => {
    const data = await loadCalendar(buildRepos(), wideRange, office);
    const withTechnicians = data.entries.find(
      (entry) => entry.kind === 'job' && entry.technicianIds.length > 0,
    );
    expect(withTechnicians).toBeDefined();
  });

  it('returns the active technicians for filtering', async () => {
    const data = await loadCalendar(buildRepos(), wideRange, office);
    expect(data.technicians.length).toBeGreaterThan(0);
    expect(data.technicians.every((user) => user.role === 'technician' && user.active)).toBe(true);
  });

  it('sorts longest entries first so bars pack cleanly', async () => {
    const data = await loadCalendar(buildRepos(), wideRange, office);
    const lengths = data.entries.map((entry) => entry.days);
    expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
  });
});

describe('entriesOn', () => {
  it('returns every entry touching a day, including mid-range days', async () => {
    const data = await loadCalendar(buildRepos(), wideRange, office);
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
          kind: 'availability',
          id: 'availability-1',
          start: today,
          end: today,
          days: 1,
          title: 'Tester',
          subtitle: 'Annual leave · All day',
          availabilityType: 'annual_leave',
          availabilityStatus: 'active',
          userId: 'u1',
          userName: 'Tester',
          userInitials: 'TT',
          blocking: true,
          allDay: true,
          timeLabel: 'All day',
          description: '',
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
