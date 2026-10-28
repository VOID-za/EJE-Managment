import { beforeEach, describe, expect, it } from 'vitest';
import { asUserId } from '@/domain';
import { businessToday } from '@/lib/business-time';
import { weekdayOf } from '@/lib/timesheet-dates';
import { acceptJob, addLabour, setCalloutApplied } from './job-operations';
import { recordAttendance } from './attendance-operations';
import {
  exportTimesheet,
  listTimesheetPeople,
  loadTimesheet,
  removeTimesheetEntry,
  saveTimesheetComment,
  saveTimesheetEntry,
} from './timesheets';
import { buildHarness, seedUser, type Harness } from './test-harness';

/**
 * TECHNICIAN TIMESHEETS — COMPLETELY MANUAL. TIMESHEET-2, the owner's
 * instruction of 27 October 2026.
 *
 * The rules under test: every value is one the technician typed; nothing is
 * read from job labour or call-out flags; a day with no line is NOT RECORDED
 * and a line of zeros is a recorded day; only the owner writes their sheet;
 * every correction is audited; the export carries exactly what was typed.
 */
const SIPHO = asUserId('user-tech-sipho');
const master = seedUser('user-master-elmarie');
const sipho = seedUser('user-tech-sipho');
const riaan = seedUser('user-tech-riaan');

const day = (offset: number): string => {
  const date = new Date(`${businessToday()}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
};

const line = (date: string, overrides: Partial<Parameters<typeof saveTimesheetEntry>[2]> = {}) => ({
  date,
  customerName: 'ABC Engineering',
  // TS-07 / TS-08 (28 October 2026): no NT on a new line; the call-out is an amount.
  overtimeHours: 1.5,
  doubleHours: 0,
  calloutAmount: 45000,
  ...overrides,
});

let harness: Harness;
beforeEach(() => {
  harness = buildHarness();
});

describe('a technician’s own manual timesheet', () => {
  it('shows every day in the range as NOT RECORDED until the technician enters it — nothing is derived', async () => {
    // Labour and a call-out on a job: the timesheet must NOT read them.
    const opened = await harness.repos.jobs.findByJobNumber('EJE-1048');
    let job = await acceptJob(harness.as(sipho), opened!);
    job = await addLabour(harness.as(sipho), job, { date: day(0), rateType: 'normal', hours: 6, description: '' });
    await setCalloutApplied(harness.as(master), job, true).catch(() => undefined);

    const sheet = await loadTimesheet(harness.as(sipho), SIPHO, day(2), day(0));
    expect(sheet.days).toHaveLength(3);
    expect(sheet.days.every((entry) => !entry.recorded && entry.entries.length === 0)).toBe(true);
    expect(sheet.totals).toMatchObject({ overtimeHours: 0, calloutAmount: 0, recordedDays: 0, unrecordedDays: 3 });
    expect(sheet.editable).toBe(true);
  });

  it('records exactly what was typed — today, or a past day later (payday)', async () => {
    await saveTimesheetEntry(harness.as(sipho), SIPHO, line(day(0)));
    await saveTimesheetEntry(harness.as(sipho), SIPHO, line(day(10), { customerName: 'Kruger', overtimeHours: 4, doubleHours: 2, calloutAmount: 0 }));

    const sheet = await loadTimesheet(harness.as(sipho), SIPHO, day(10), day(0));
    const today = sheet.days.find((entry) => entry.date === day(0))!;
    const past = sheet.days.find((entry) => entry.date === day(10))!;
    expect(today).toMatchObject({ recorded: true, overtimeHours: 1.5, doubleHours: 0, calloutAmount: 45000 });
    expect(past).toMatchObject({ recorded: true, overtimeHours: 4, doubleHours: 2 });
    expect(past.entries[0]?.customerName).toBe('Kruger');
    expect(sheet.totals).toMatchObject({ overtimeHours: 5.5, doubleHours: 2, calloutAmount: 45000, recordedDays: 2 });
  });

  it('keeps a recorded day of zero hours apart from an unrecorded day', async () => {
    await saveTimesheetEntry(harness.as(sipho), SIPHO, line(day(1), { customerName: '', overtimeHours: 0, calloutAmount: 0 }));
    const sheet = await loadTimesheet(harness.as(sipho), SIPHO, day(2), day(1));
    expect(sheet.days.find((entry) => entry.date === day(1))?.recorded).toBe(true);
    expect(sheet.days.find((entry) => entry.date === day(2))?.recorded).toBe(false);
  });

  it('takes several customers on one day, and refuses a day over 24 hours', async () => {
    await saveTimesheetEntry(harness.as(sipho), SIPHO, line(day(0), { overtimeHours: 8, doubleHours: 4 }));
    await saveTimesheetEntry(harness.as(sipho), SIPHO, line(day(0), { customerName: 'Kruger', overtimeHours: 6 }));
    await expect(
      saveTimesheetEntry(harness.as(sipho), SIPHO, line(day(0), { customerName: 'Late', overtimeHours: 7 })),
    ).rejects.toMatchObject({ violations: [{ code: 'day_over_24_hours' }] });
    const sheet = await loadTimesheet(harness.as(sipho), SIPHO, day(0), day(0));
    expect(sheet.days[0]?.entries).toHaveLength(2);
  });

  it('validates values and dates on the server', async () => {
    const refuse = (input: ReturnType<typeof line>) => saveTimesheetEntry(harness.as(sipho), SIPHO, input);
    // NT is no longer entered at all (TS-07).
    await expect(refuse(line(day(0), { normalHours: 1 }))).rejects.toMatchObject({ violations: [{ code: 'nt_not_entered' }] });
    await expect(refuse(line(day(0), { overtimeHours: 25 }))).rejects.toMatchObject({ violations: [{ code: 'invalid_overtime_hours' }] });
    await expect(refuse(line(day(0), { doubleHours: 1.1 }))).rejects.toMatchObject({ violations: [{ code: 'invalid_double_hours' }] });
    await expect(refuse(line(day(0), { calloutAmount: 1.5 }))).rejects.toMatchObject({ violations: [{ code: 'invalid_callout_amount' }] });
    await expect(refuse(line(day(0), { customerName: '  ' }))).rejects.toMatchObject({ violations: [{ code: 'customer_required' }] });
    await expect(refuse(line(day(-1)))).rejects.toMatchObject({ violations: [{ code: 'date_in_future' }] });
    await expect(refuse(line('2026-02-30'))).rejects.toMatchObject({ violations: [{ code: 'invalid_date' }] });
  });

  it('takes the customer’s name from the register when one is chosen', async () => {
    const entry = await saveTimesheetEntry(harness.as(sipho), SIPHO, line(day(0), { customerId: 'cust-abc', customerName: '' }));
    const customer = await harness.repos.customers.findById(entry.customerId!);
    expect(entry.customerName).toBe(customer?.name);
  });

  it('corrects and removes a line, each audited with what changed', async () => {
    const entry = await saveTimesheetEntry(harness.as(sipho), SIPHO, line(day(0)));
    const corrected = await saveTimesheetEntry(harness.as(sipho), SIPHO, { ...line(day(0), { overtimeHours: 2.5 }), entryId: entry.id });
    expect(corrected.id).toBe(entry.id);
    expect(corrected.overtimeHours).toBe(2.5);
    await removeTimesheetEntry(harness.as(sipho), SIPHO, entry.id);

    const trail = await harness.repos.activity.list(undefined);
    const types = trail.map((event) => event.type);
    expect(types).toContain('timesheet_entry_added');
    expect(types).toContain('timesheet_entry_removed');
    const correction = trail.find((event) => event.type === 'timesheet_entry_corrected');
    expect(correction?.changes).toEqual([{ field: 'OT', from: '1.5', to: '2.5' }]);
    expect((await loadTimesheet(harness.as(sipho), SIPHO, day(0), day(0))).days[0]?.recorded).toBe(false);
  });

  it('lets ONLY the owner write: not another technician, not the office', async () => {
    await expect(saveTimesheetEntry(harness.as(riaan), SIPHO, line(day(0)))).rejects.toMatchObject({ violations: [{ code: 'not_permitted' }] });
    await expect(saveTimesheetEntry(harness.as(master), SIPHO, line(day(0)))).rejects.toMatchObject({ violations: [{ code: 'not_permitted' }] });
    const mine = await saveTimesheetEntry(harness.as(sipho), SIPHO, line(day(0)));
    // Riaan cannot correct or remove Sipho's line through his own sheet either.
    await expect(
      saveTimesheetEntry(harness.as(riaan), riaan.id, { ...line(day(0)), entryId: mine.id }),
    ).rejects.toMatchObject({ violations: [{ code: 'entry_not_found' }] });
    await expect(removeTimesheetEntry(harness.as(riaan), riaan.id, mine.id)).rejects.toMatchObject({ violations: [{ code: 'entry_not_found' }] });
    expect(mine.userId).toBe(SIPHO);
  });

  it('a technician reads their own sheet only; the office reads anybody’s but cannot edit it', async () => {
    await expect(loadTimesheet(harness.as(riaan), SIPHO, day(0), day(0))).rejects.toMatchObject({ violations: [{ code: 'not_permitted' }] });
    const office = await loadTimesheet(harness.as(master), SIPHO, day(0), day(0));
    expect(office.editable).toBe(false);
    expect((await listTimesheetPeople(harness.as(sipho))).map((person) => person.id)).toEqual([SIPHO]);
  });

  it('keeps the day comment and shows the manual attendance for reference', async () => {
    await saveTimesheetComment(harness.as(sipho), SIPHO, day(0), 'Waited for the crane');
    await recordAttendance(harness.as(master), { userId: SIPHO, date: day(0), status: 'present', note: '' });
    const sheet = await loadTimesheet(harness.as(sipho), SIPHO, day(0), day(0));
    expect(sheet.days[0]).toMatchObject({ comment: 'Waited for the crane', attendance: 'present', recorded: false });
  });

  it('exports exactly what was typed, and marks an unrecorded day NOT RECORDED', async () => {
    await saveTimesheetEntry(harness.as(sipho), SIPHO, line(day(0)));
    const file = await exportTimesheet(harness.as(master), SIPHO, day(1), day(0));
    const [header, ...rows] = file.csv.replace(/^﻿/u, '').trim().split('\r\n');
    expect(header).toBe(
      'Date,Day,Customer,OT,DT,Callout (R),Callout shared,Internal km,Customer km,NT (historical),Callouts (historical count),Day comment (historical),Attendance',
    );
    expect(rows).toEqual([
      `${day(1)},${weekdayOf(day(1))},NOT RECORDED,,,,,,,,,,`,
      `${day(0)},${weekdayOf(day(0))},ABC Engineering,1.50,0.00,450.00,,0.0,0.0,,,,`,
    ]);
  });
});
