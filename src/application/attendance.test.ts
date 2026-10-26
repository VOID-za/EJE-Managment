import { beforeEach, describe, expect, it } from 'vitest';
import { asUserId } from '@/domain';
import { businessToday } from '@/lib/business-time';
import { loadAttendanceRegister, recordAttendance } from './attendance-operations';
import { WorkflowError } from './errors';
import { buildHarness, seedUser, type Harness } from './test-harness';

/**
 * THE ATTENDANCE REGISTER. ATTEND-1.
 *
 * Seeded facts: Thabo Nkosi has sick leave booked from yesterday to tomorrow;
 * Yusuf Patel's account is disabled. Nobody has any attendance recorded — the
 * register starts empty, because nothing was recorded before it existed.
 */
const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');
const technician = seedUser('user-tech-sipho');
const THABO = 'user-tech-thabo';

const shiftDays = (iso: string, days: number): string => {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const refusal = async (work: Promise<unknown>): Promise<string[]> => {
  const error = await work.then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(WorkflowError);
  return (error as WorkflowError).violations.map((violation) => violation.code);
};

describe('recording attendance', () => {
  let harness: Harness;
  let today: string;
  beforeEach(() => {
    harness = buildHarness();
    today = businessToday();
  });

  it('records a day, and a second answer CORRECTS it — never a second record', async () => {
    const context = harness.as(coordinator);
    const first = await recordAttendance(context, { userId: 'user-tech-sipho', date: today, status: 'present', note: '' });
    const corrected = await recordAttendance(context, {
      userId: 'user-tech-sipho',
      date: today,
      status: 'absent',
      note: 'Phoned in at 07:10',
    });

    expect(corrected.id).toBe(first.id);
    const records = await harness.repos.attendance.listRecords(today, today, asUserId('user-tech-sipho'));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: 'absent', note: 'Phoned in at 07:10', recordedBy: coordinator.id });

    // The history is the audit trail: what it said, and what it says now.
    const events = await harness.repos.activity.list();
    expect(events.filter((event) => event.type === 'attendance_recorded')).toHaveLength(1);
    const correction = events.find((event) => event.type === 'attendance_corrected');
    expect(correction?.changes).toEqual([
      { field: 'Attendance', from: 'Present', to: 'Absent' },
      { field: 'Note', from: '—', to: 'Phoned in at 07:10' },
    ]);
  });

  it('the same answer again writes nothing', async () => {
    const context = harness.as(master);
    await recordAttendance(context, { userId: 'user-tech-sipho', date: today, status: 'present', note: 'On site' });
    const before = (await harness.repos.activity.list()).length;
    await recordAttendance(context, { userId: 'user-tech-sipho', date: today, status: 'present', note: ' On site ' });
    expect((await harness.repos.activity.list()).length).toBe(before);
  });

  it('is the office’s: a technician cannot record anybody, themselves included', async () => {
    expect(
      await refusal(
        recordAttendance(harness.as(technician), { userId: technician.id, date: today, status: 'present', note: '' }),
      ),
    ).toEqual(['not_permitted']);
    expect(await harness.repos.attendance.listRecords(today, today)).toHaveLength(0);
  });

  it('refuses a day that has not happened, a non-date, a disabled account and an unknown person', async () => {
    const context = harness.as(master);
    const record = (over: object) =>
      recordAttendance(context, { userId: 'user-tech-sipho', date: today, status: 'present', note: '', ...over });
    expect(await refusal(record({ date: shiftDays(today, 1) }))).toEqual(['date_in_future']);
    expect(await refusal(record({ date: '2026-02-30' }))).toEqual(['invalid_date']);
    expect(await refusal(record({ userId: 'user-tech-yusuf' }))).toEqual(['user_inactive']);
    expect(await refusal(record({ userId: 'nobody' }))).toEqual(['unknown_user']);
    expect(await refusal(record({ note: 'x'.repeat(501) }))).toEqual(['note_too_long']);
    // A past day is a fact and may be recorded late.
    await expect(record({ date: shiftDays(today, -3) })).resolves.toMatchObject({ status: 'present' });
  });
});

describe('the register, and what it keeps apart', () => {
  it('shows planned leave beside the person, and recording attendance leaves the leave alone', async () => {
    const harness = buildHarness();
    const today = businessToday();
    const leaveBefore = await harness.repos.availability.listForUser(asUserId(THABO));

    // Thabo came in despite the sick leave booked for today.
    await recordAttendance(harness.as(master), { userId: THABO, date: today, status: 'present', note: 'Came in after all' });

    const register = await loadAttendanceRegister(harness.as(master), today);
    const row = register.rows.find((entry) => entry.user.id === THABO)!;
    expect(row.record?.status).toBe('present');
    expect(row.plannedLeave.map((leave) => leave.type)).toEqual(['sick_leave']);
    expect(row.recordedByName).toBe('Elmarie Coetzee');
    expect(await harness.repos.availability.listForUser(asUserId(THABO))).toEqual(leaveBefore);

    // Everybody active is listed; the disabled account is not.
    expect(register.rows.some((entry) => entry.user.id === 'user-tech-yusuf')).toBe(false);
    expect(register.present).toBe(1);
    expect(register.unrecorded).toBe(register.rows.length - 1);
  });

  it('touches no job', async () => {
    const harness = buildHarness();
    const before = JSON.stringify(await harness.repos.jobs.list());
    await recordAttendance(harness.as(master), { userId: 'user-tech-sipho', date: businessToday(), status: 'absent', note: '' });
    expect(JSON.stringify(await harness.repos.jobs.list())).toBe(before);
  });

  it('is refused to a technician', async () => {
    const harness = buildHarness();
    expect(await refusal(loadAttendanceRegister(harness.as(technician), businessToday()))).toEqual(['not_permitted']);
  });
});
