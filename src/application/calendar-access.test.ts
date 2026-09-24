import { beforeEach, describe, expect, it } from 'vitest';
import { can } from '@/domain';
import { loadCalendar } from './calendar';
import { createAvailability } from './availability-operations';
import { WorkflowError } from './errors';
import { buildHarness, dayOffset, seedUser, type Harness } from './test-harness';

/**
 * THE CALENDAR, BY ROLE. MASTER SCOPE §3.3, §8, §16, §24-CAL.
 *
 * §3.3 is unambiguous — "Technicians MUST be able to view the Calendar" — and
 * the audit against `95e9848` measured a 403. The cause was one capability
 * doing two jobs: `availability.manage` gated both READING the schedule and
 * WRITING the leave register, so giving a technician the screen would have
 * handed them everybody's absences and the power to change them.
 *
 * So there are two capabilities now, and this file holds both halves against
 * each other. There was no test of calendar access by role at all before —
 * which is why the defect shipped.
 */
const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');
const technician = seedUser('user-tech-sipho');
const otherTechnician = seedUser('user-tech-thabo');

const range = { from: dayOffset(-60), to: dayOffset(60) };

describe('who may READ the calendar', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('gives it to all three roles — §3.3', () => {
    expect(can(master.role, 'calendar.view')).toBe(true);
    expect(can(coordinator.role, 'calendar.view')).toBe(true);
    expect(can(technician.role, 'calendar.view')).toBe(true);
  });

  it('serves a technician a calendar with work on it', async () => {
    const data = await loadCalendar(harness.repos, range, technician);
    const jobs = data.entries.filter((entry) => entry.kind === 'job');

    // Not merely "it did not throw": a calendar with nothing on it would pass
    // a 200 check and fail the requirement.
    expect(jobs.length).toBeGreaterThan(0);
  });

  it('shows a technician only the jobs DECISION 5 already gives them', async () => {
    const [officeView, fieldView] = await Promise.all([
      loadCalendar(harness.repos, range, master),
      loadCalendar(harness.repos, range, technician),
    ]);

    const jobsIn = (data: Awaited<ReturnType<typeof loadCalendar>>) =>
      data.entries.filter((entry) => entry.kind === 'job').map((entry) => entry.id);

    const office = jobsIn(officeView);
    const field = jobsIn(fieldView);

    // A subset, and a strict one: the office plans, the field works.
    expect(field.every((id) => office.includes(id))).toBe(true);
    expect(field.length).toBeLessThan(office.length);
  });
});

describe('whose absences a calendar shows', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('shows the office everybody’s', async () => {
    const data = await loadCalendar(harness.repos, range, master);
    const people = new Set(
      data.entries
        .filter((entry) => entry.kind === 'availability')
        .map((entry) => (entry.kind === 'availability' ? entry.userId : '')),
    );
    expect(people.size).toBeGreaterThan(1);
  });

  it('shows a technician their own and nobody else’s', async () => {
    /*
     * §16 asks for a calendar a technician can WORK FROM. Another technician's
     * sick leave is that person's business, and the staff absence register is
     * what `availability.manage` exists for.
     */
    const data = await loadCalendar(harness.repos, range, technician);
    const absences = data.entries.filter((entry) => entry.kind === 'availability');

    expect(absences.every((entry) => entry.kind === 'availability' && entry.userId === technician.id)).toBe(
      true,
    );
    expect(
      absences.some((entry) => entry.kind === 'availability' && entry.userId === otherTechnician.id),
    ).toBe(false);
  });
});

describe('who may WRITE the calendar — §8', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  const absence = {
    userId: technician.id,
    type: 'annual_leave' as const,
    startDate: dayOffset(20),
    endDate: dayOffset(21),
    allDay: true,
    startTime: null,
    endTime: null,
    description: 'December leave',
  };

  it('lets a Master record an absence', async () => {
    const result = await createAvailability(harness.as(master), absence);
    expect(result.record.userId).toBe(technician.id);
  });

  it('lets a COORDINATOR record one — §3.2, she runs scheduling', async () => {
    /*
     * The capability table always said so; the operation checked
     * `role === 'master'` instead and refused her. She could open the calendar
     * and do nothing on it.
     */
    expect(can(coordinator.role, 'availability.manage')).toBe(true);
    const result = await createAvailability(harness.as(coordinator), absence);
    expect(result.record.userId).toBe(technician.id);
    expect(result.record.status).toBe('active');
  });

  it('refuses a technician, who tells the office by message instead', async () => {
    expect(can(technician.role, 'availability.manage')).toBe(false);
    await expect(createAvailability(harness.as(technician), absence)).rejects.toBeInstanceOf(
      WorkflowError,
    );
  });

  it('does not let READING the calendar imply WRITING it', async () => {
    // The whole reason the capabilities were split. A technician who can now
    // see the schedule still cannot put anybody on leave.
    expect(can(technician.role, 'calendar.view')).toBe(true);
    expect(can(technician.role, 'availability.manage')).toBe(false);
    await expect(createAvailability(harness.as(technician), absence)).rejects.toThrow(
      /only the office/i,
    );
  });
});
