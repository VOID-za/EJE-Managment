import { beforeEach, describe, expect, it } from 'vitest';
import { asUserId } from '@/domain';
import { businessToday } from '@/lib/business-time';
import { loadMyAttendance, recordAttendance } from './attendance-operations';
import { WorkflowError } from './errors';
import { buildHarness, seedUser, type Harness } from './test-harness';

/**
 * ATTENDANCE. ATTEND-1, ATTEND-2; ATT-OWN-1 (the tester, 1 November 2026):
 * every person records their own days and nobody else's — the office included.
 *
 * Seeded facts: Thabo Nkosi has sick leave booked from yesterday to tomorrow;
 * Yusuf Patel's account is disabled. Nobody has any attendance recorded.
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
    const first = await recordAttendance(context, { userId: coordinator.id, date: today, status: 'present', note: '' });
    const corrected = await recordAttendance(context, {
      userId: coordinator.id,
      date: today,
      status: 'absent',
      // ATT-01 (28 October 2026): an absent day says why.
      absenceReason: 'sick_leave',
      note: 'Phoned in at 07:10',
    });

    expect(corrected.id).toBe(first.id);
    const records = await harness.repos.attendance.listRecords(today, today, coordinator.id);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: 'absent', absenceReason: 'sick_leave', note: 'Phoned in at 07:10', recordedBy: coordinator.id });

    // The history is the audit trail: what it said, and what it says now.
    const events = await harness.repos.activity.list();
    expect(events.filter((event) => event.type === 'attendance_recorded')).toHaveLength(1);
    const correction = events.find((event) => event.type === 'attendance_corrected');
    expect(correction?.changes).toEqual([
      { field: 'Attendance', from: 'Present', to: 'Absent' },
      { field: 'Absence reason', from: 'Not recorded', to: 'Sick Leave' },
      { field: 'Note', from: '—', to: 'Phoned in at 07:10' },
    ]);
  });

  it('the same answer again writes nothing', async () => {
    const context = harness.as(master);
    await recordAttendance(context, { userId: master.id, date: today, status: 'present', note: 'On site' });
    const before = (await harness.repos.activity.list()).length;
    await recordAttendance(context, { userId: master.id, date: today, status: 'present', note: ' On site ' });
    expect((await harness.repos.activity.list()).length).toBe(before);
  });

  it('lets a technician mark THEMSELVES — today and an earlier day — and nobody else (ATTEND-2)', async () => {
    const own = await recordAttendance(harness.as(technician), { userId: technician.id, date: today, status: 'present', note: '' });
    expect(own).toMatchObject({ userId: technician.id, status: 'present', recordedBy: technician.id });
    const earlier = shiftDays(today, -12);
    await recordAttendance(harness.as(technician), { userId: technician.id, date: earlier, status: 'absent', absenceReason: 'sick_leave', note: 'Sick' });
    // Corrected later: still one record for that day, and the correction is audited.
    await recordAttendance(harness.as(technician), { userId: technician.id, date: earlier, status: 'present', note: '' });
    expect((await harness.repos.attendance.listRecords(earlier, earlier, technician.id)).map((r) => r.status)).toEqual(['present']);
    expect((await harness.repos.activity.list(undefined)).some((event) => event.type === 'attendance_corrected')).toBe(true);

    expect(
      await refusal(recordAttendance(harness.as(technician), { userId: THABO, date: today, status: 'absent', absenceReason: 'leave', note: '' })),
    ).toEqual(['not_permitted']);
    expect(await harness.repos.attendance.listRecords(today, today, asUserId(THABO))).toHaveLength(0);
  });

  it('shows a technician their own days, unrecorded ones said as such — nothing inferred (ATTEND-2)', async () => {
    await recordAttendance(harness.as(technician), { userId: technician.id, date: today, status: 'present', note: '' });
    const mine = await loadMyAttendance(harness.as(technician), shiftDays(today, -2), today);
    // ATT-ORDER-1 (2 November 2026): oldest first, newest last.
    expect(mine.days.map((day) => day.date)).toEqual([shiftDays(today, -2), shiftDays(today, -1), today]);
    expect(mine.days[2]?.record?.status).toBe('present');
    expect(mine.days.slice(0, 2).every((day) => day.record === null)).toBe(true);
    expect(mine.unrecorded).toBe(2);
    // Another person's record never appears on this list.
    await recordAttendance(harness.as(seedUser(THABO)), { userId: THABO, date: shiftDays(today, -1), status: 'present', note: '' });
    expect((await loadMyAttendance(harness.as(technician), shiftDays(today, -2), today)).unrecorded).toBe(2);
  });

  it('refuses a day that has not happened, a non-date, a disabled account and an unknown person', async () => {
    const context = harness.as(master);
    const record = (over: object) =>
      recordAttendance(context, { userId: master.id, date: today, status: 'present', note: '', ...over });
    expect(await refusal(record({ date: shiftDays(today, 1) }))).toEqual(['date_in_future']);
    expect(await refusal(record({ date: '2026-02-30' }))).toEqual(['invalid_date']);
    // Anybody else — disabled, unknown or not — is refused before anything is read (ATT-OWN-1).
    expect(await refusal(record({ userId: 'user-tech-yusuf' }))).toEqual(['not_permitted']);
    expect(await refusal(record({ userId: 'nobody' }))).toEqual(['not_permitted']);
    // A disabled account recording for itself (a session from before it was disabled).
    expect(
      await refusal(recordAttendance(harness.as(seedUser('user-tech-yusuf')), { userId: 'user-tech-yusuf', date: today, status: 'present', note: '' })),
    ).toEqual(['user_inactive']);
    expect(await refusal(record({ note: 'x'.repeat(501) }))).toEqual(['note_too_long']);
    // A past day is a fact and may be recorded late.
    await expect(record({ date: shiftDays(today, -3) })).resolves.toMatchObject({ status: 'present' });
  });
});

/*
 * ATT-AUTO-1 (the tester, 31 October 2026): attendance saves itself as it is
 * filled in, so a screen may be saving a day another person has since
 * recorded. It says which record it was looking at; a newer one is never
 * overwritten by it.
 */
describe('an autosave that says what it expected', () => {
  let harness: Harness;
  let today: string;
  beforeEach(() => {
    harness = buildHarness();
    today = businessToday();
  });
  const later = () => new Promise((resolve) => setTimeout(resolve, 3));

  it('saves when the day is as the screen saw it — no record, then its own record', async () => {
    const own = harness.as(technician);
    const first = await recordAttendance(own, { userId: 'user-tech-sipho', date: today, status: 'present', note: '', expectedRecordedAt: null });
    await later();
    const second = await recordAttendance(own, {
      userId: 'user-tech-sipho', date: today, status: 'absent', absenceReason: 'sick_leave', note: '', expectedRecordedAt: first.recordedAt,
    });
    expect(second.id).toBe(first.id);
    expect(second.status).toBe('absent');
  });

  it('refuses a stale screen instead of overwriting the newer answer from the person’s other device', async () => {
    const seen = await recordAttendance(harness.as(technician), { userId: 'user-tech-sipho', date: today, status: 'present', note: '' });
    await later();
    // The same person, on the tablet, while the phone still shows "present".
    await recordAttendance(harness.as(technician), { userId: 'user-tech-sipho', date: today, status: 'absent', absenceReason: 'leave', note: 'Booked' });
    expect(
      await refusal(recordAttendance(harness.as(technician), { userId: 'user-tech-sipho', date: today, status: 'present', note: '', expectedRecordedAt: seen.recordedAt })),
    ).toEqual(['attendance_changed']);
    // A screen that thought there was no record is refused the same way.
    expect(
      await refusal(recordAttendance(harness.as(technician), { userId: 'user-tech-sipho', date: today, status: 'present', note: '', expectedRecordedAt: null })),
    ).toEqual(['attendance_changed']);
    const [kept] = await harness.repos.attendance.listRecords(today, today).then((rows) => rows.filter((row) => row.userId === 'user-tech-sipho'));
    expect(kept).toMatchObject({ status: 'absent', absenceReason: 'leave', note: 'Booked' });
  });

  it('never calls repeating the current answer a conflict, and writes nothing for it', async () => {
    const current = await recordAttendance(harness.as(technician), { userId: 'user-tech-sipho', date: today, status: 'present', note: '' });
    const again = await recordAttendance(harness.as(technician), { userId: 'user-tech-sipho', date: today, status: 'present', note: '', expectedRecordedAt: 'an old screen' });
    expect(again).toEqual(current);
  });
});

/*
 * ATT-OWN-1 (the tester, 1 November 2026). The Team register is gone: a Master
 * or a Coordinator records their OWN days, exactly as a technician does, and
 * is refused anybody else's — creating it, correcting it, or recording it for a
 * disabled colleague. Asked of the operation, so no screen or route matters.
 */
describe('nobody records another person’s attendance (ATT-OWN-1)', () => {
  for (const [label, actor] of [['a Master', master], ['a Coordinator', coordinator], ['a Technician', technician]] as const) {
    it(`${label} records their own days, and is refused anybody else’s — new or a correction`, async () => {
      const harness = buildHarness();
      const today = businessToday();
      const own = await recordAttendance(harness.as(actor), { userId: actor.id, date: today, status: 'present', note: '' });
      expect(own).toMatchObject({ userId: actor.id, recordedBy: actor.id });
      // Corrects their own day.
      await recordAttendance(harness.as(actor), { userId: actor.id, date: today, status: 'absent', absenceReason: 'sick_leave', note: '' });

      // Thabo records his own day; nobody else may create or correct it.
      await recordAttendance(harness.as(seedUser(THABO)), { userId: THABO, date: today, status: 'present', note: '' });
      for (const attempt of [
        { userId: THABO, date: today, status: 'absent' as const, absenceReason: 'leave', note: 'Overwritten?' },
        { userId: THABO, date: shiftDays(today, -1), status: 'present' as const, note: 'Created for him?' },
      ]) {
        expect(await refusal(recordAttendance(harness.as(actor), attempt))).toEqual(['not_permitted']);
      }
      const thabos = await harness.repos.attendance.listRecords(shiftDays(today, -1), today, asUserId(THABO));
      expect(thabos).toHaveLength(1);
      expect(thabos[0]).toMatchObject({ status: 'present', recordedBy: THABO, note: '' });
    });
  }

  it('records nothing for the office: the old register screen’s save for someone else is refused', async () => {
    const harness = buildHarness();
    const before = (await harness.repos.activity.list()).length;
    expect(
      await refusal(recordAttendance(harness.as(coordinator), { userId: 'user-tech-sipho', date: businessToday(), status: 'present', note: '', expectedRecordedAt: null })),
    ).toEqual(['not_permitted']);
    expect(await harness.repos.attendance.listRecords(businessToday(), businessToday())).toHaveLength(0);
    expect((await harness.repos.activity.list()).length).toBe(before);
  });
});

describe('what attendance keeps apart', () => {
  it('recording attendance leaves the planned leave alone', async () => {
    const harness = buildHarness();
    const today = businessToday();
    const leaveBefore = await harness.repos.availability.listForUser(asUserId(THABO));
    // Thabo came in despite the sick leave booked for today.
    await recordAttendance(harness.as(seedUser(THABO)), { userId: THABO, date: today, status: 'present', note: 'Came in after all' });
    expect(await harness.repos.availability.listForUser(asUserId(THABO))).toEqual(leaveBefore);
  });

  it('touches no job', async () => {
    const harness = buildHarness();
    const before = JSON.stringify(await harness.repos.jobs.list());
    await recordAttendance(harness.as(technician), { userId: technician.id, date: businessToday(), status: 'absent', absenceReason: 'leave', note: '' });
    expect(JSON.stringify(await harness.repos.jobs.list())).toBe(before);
  });
});

