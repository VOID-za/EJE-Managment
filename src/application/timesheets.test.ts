import { beforeEach, describe, expect, it } from 'vitest';
import { asUserId, type Job, type LabourEntry, type LabourRateType } from '@/domain';
import { businessToday } from '@/lib/business-time';
import { acceptJob, addLabour } from './job-operations';
import { recordAttendance } from './attendance-operations';
import {
  buildTimesheetRows,
  exportTimesheet,
  listTimesheetPeople,
  loadTimesheet,
  saveTimesheetComment,
} from './timesheets';
import { WorkflowError } from './errors';
import { buildHarness, seedUser, type Harness } from './test-harness';

/**
 * TECHNICIAN TIMESHEETS. TIMESHEET-1.
 *
 * The rules under test: hours are the technician's OWN labour lines, summed by
 * day and customer, never copied and never counted twice; a call-out is counted
 * once per job, on the technician's first day on it; the day's comment is the
 * one new record; and only the office may open somebody else's sheet.
 */
const SIPHO = asUserId('user-tech-sipho');
const RIAAN = asUserId('user-tech-riaan');
const master = seedUser('user-master-elmarie');
const sipho = seedUser('user-tech-sipho');

let lineNumber = 0;
const line = (technicianId: string, date: string, rateType: LabourRateType, hours: number): LabourEntry =>
  ({
    id: `line-${(lineNumber += 1)}`,
    technicianId: asUserId(technicianId),
    date,
    rateType,
    hours,
    description: 'Work',
    capturedAt: `${date}T10:00:00.000Z`,
    capturedBy: asUserId(technicianId),
  }) as LabourEntry;

describe('building the sheet from the labour lines', () => {
  let base: Job;
  beforeEach(async () => {
    base = (await buildHarness().repos.jobs.findByJobNumber('EJE-1048'))!;
  });

  const job = (jobNumber: string, customerId: string, labour: LabourEntry[], calloutApplied = false): Job =>
    ({ ...base, id: jobNumber, jobNumber, customerId, labour, calloutApplied }) as unknown as Job;

  const customers = [
    { id: 'cust-abc', name: 'ABC Engineering' },
    { id: 'cust-kruger', name: 'Kruger Engineering' },
  ] as never;

  it('sums each rate by day and customer, from this technician’s lines only', () => {
    const { rows, totals } = buildTimesheetRows({
      technicianId: SIPHO,
      from: '2026-10-01',
      to: '2026-10-31',
      jobs: [
        job('EJE-1', 'cust-abc', [
          line(SIPHO, '2026-10-05', 'normal', 8),
          line(SIPHO, '2026-10-05', 'overtime', 2),
          line(RIAAN, '2026-10-05', 'overtime', 5), // somebody else's — not his
        ]),
        // A second job, same customer, same day: one row, both job numbers.
        job('EJE-2', 'cust-abc', [line(SIPHO, '2026-10-05', 'double', 1.5)]),
        job('EJE-3', 'cust-kruger', [line(SIPHO, '2026-10-06', 'normal', 4)]),
      ],
      customers,
      comments: [],
      attendance: new Map(),
    });

    expect(rows.map((row) => [row.date, row.customerName, row.jobNumbers, row.normalHours, row.overtimeHours, row.doubleHours])).toEqual([
      ['2026-10-05', 'ABC Engineering', ['EJE-1', 'EJE-2'], 8, 2, 1.5],
      ['2026-10-06', 'Kruger Engineering', ['EJE-3'], 4, 0, 0],
    ]);
    // Every hour counted exactly once — Riaan's five are not on Sipho's sheet.
    expect(totals).toEqual({ normalHours: 12, overtimeHours: 2, doubleHours: 1.5, callouts: 0 });
  });

  it('counts a call-out ONCE per job, on the technician’s first day, even across a range boundary', () => {
    const calloutJob = job(
      'EJE-9',
      'cust-abc',
      [line(SIPHO, '2026-09-30', 'normal', 3), line(SIPHO, '2026-10-01', 'normal', 6), line(SIPHO, '2026-10-02', 'normal', 6)],
      true,
    );
    const october = buildTimesheetRows({
      technicianId: SIPHO, from: '2026-10-01', to: '2026-10-31', jobs: [calloutJob], customers, comments: [], attendance: new Map(),
    });
    // His first day on it was 30 September: October shows no call-out at all.
    expect(october.totals.callouts).toBe(0);

    const september = buildTimesheetRows({
      technicianId: SIPHO, from: '2026-09-01', to: '2026-09-30', jobs: [calloutJob], customers, comments: [], attendance: new Map(),
    });
    expect(september.rows).toHaveLength(1);
    expect(september.rows[0]).toMatchObject({ date: '2026-09-30', callouts: 1 });

    // And a job without the fee shows none, however many days.
    const plain = buildTimesheetRows({
      technicianId: SIPHO, from: '2026-09-01', to: '2026-10-31', jobs: [{ ...calloutJob, calloutApplied: false }], customers, comments: [], attendance: new Map(),
    });
    expect(plain.totals.callouts).toBe(0);
  });

  it('carries the day’s comment once, keeps a comment-only day, and shows attendance', () => {
    const { rows } = buildTimesheetRows({
      technicianId: SIPHO,
      from: '2026-10-01',
      to: '2026-10-31',
      jobs: [
        job('EJE-1', 'cust-abc', [line(SIPHO, '2026-10-05', 'normal', 4)]),
        job('EJE-3', 'cust-kruger', [line(SIPHO, '2026-10-05', 'normal', 3)]),
      ],
      customers,
      comments: [
        { id: 'c1', userId: SIPHO, date: '2026-10-05', comment: 'Waited for the crane', updatedBy: SIPHO, updatedAt: '' },
        { id: 'c2', userId: SIPHO, date: '2026-10-07', comment: 'Training day', updatedBy: SIPHO, updatedAt: '' },
      ],
      attendance: new Map([['2026-10-05', 'present' as const]]),
    });
    expect(rows.map((row) => [row.date, row.customerName, row.comment, row.firstOfDay, row.attendance])).toEqual([
      ['2026-10-05', 'ABC Engineering', 'Waited for the crane', true, 'present'],
      ['2026-10-05', 'Kruger Engineering', '', false, 'present'],
      ['2026-10-07', '', 'Training day', true, null],
    ]);
  });
});

describe('the timesheet through the operations', () => {
  let harness: Harness;
  let today: string;
  beforeEach(() => {
    harness = buildHarness();
    today = businessToday();
  });

  it('reads the hours a technician captured on a job, without copying or changing them', async () => {
    const context = harness.as(sipho);
    let job = await acceptJob(context, (await harness.repos.jobs.findByJobNumber('EJE-1048'))!);
    job = await addLabour(context, job, { date: today, rateType: 'overtime', hours: 2.5, description: 'Night call' });
    const labourBefore = JSON.stringify(job.labour);

    const sheet = await loadTimesheet(context, SIPHO, today, today);
    const row = sheet.rows.find((entry) => entry.jobNumbers.includes('EJE-1048'));
    expect(row?.overtimeHours).toBeGreaterThanOrEqual(2.5);
    expect(row?.customerName).toBe('ABC Engineering (Pty) Ltd');

    // Reading and commenting leave the job's labour exactly as it was.
    await saveTimesheetComment(context, SIPHO, today, 'Called out after hours');
    const stored = await harness.repos.jobs.findByJobNumber('EJE-1048');
    expect(JSON.stringify(stored!.labour)).toBe(labourBefore);
  });

  it('a technician opens their own sheet and nobody else’s; the office opens anybody’s', async () => {
    await expect(loadTimesheet(harness.as(sipho), SIPHO, today, today)).resolves.toBeDefined();
    const refused = await loadTimesheet(harness.as(sipho), RIAAN, today, today).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(WorkflowError);
    expect((refused as WorkflowError).violations[0]?.code).toBe('not_permitted');
    await expect(loadTimesheet(harness.as(master), RIAAN, today, today)).resolves.toBeDefined();

    expect((await listTimesheetPeople(harness.as(sipho))).map((person) => person.id)).toEqual([SIPHO]);
    expect((await listTimesheetPeople(harness.as(master))).length).toBeGreaterThan(1);
  });

  it('refuses a backwards range and one longer than a quarter', async () => {
    const codes = async (from: string, to: string) =>
      ((await loadTimesheet(harness.as(master), SIPHO, from, to).catch((error: unknown) => error)) as WorkflowError)
        .violations.map((violation) => violation.code);
    expect(await codes('2026-10-10', '2026-10-01')).toEqual(['invalid_range']);
    expect(await codes('2026-01-01', '2026-10-01')).toEqual(['range_too_long']);
  });

  it('writes, changes and clears the day’s comment — one per day, each change audited', async () => {
    const context = harness.as(sipho);
    await saveTimesheetComment(context, SIPHO, today, 'Waited two hours for the crane');
    await saveTimesheetComment(context, SIPHO, today, 'Waited three hours for the crane');
    expect(await harness.repos.attendance.listComments(SIPHO, today, today)).toHaveLength(1);
    expect((await harness.repos.attendance.findComment(SIPHO, today))?.comment).toBe('Waited three hours for the crane');

    await saveTimesheetComment(context, SIPHO, today, '   ');
    expect(await harness.repos.attendance.findComment(SIPHO, today)).toBeNull();

    const summaries = (await harness.repos.activity.list())
      .filter((event) => event.type === 'timesheet_comment_saved')
      .map((event) => event.summary.split(':')[0]);
    expect(summaries.sort()).toEqual(['Timesheet comment added', 'Timesheet comment changed', 'Timesheet comment cleared']);

    // Somebody else's day is refused to a technician.
    const refused = await saveTimesheetComment(context, RIAAN, today, 'Not mine').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(WorkflowError);
  });

  it('exports the same rows as a CSV with the timesheet’s columns', async () => {
    const context = harness.as(sipho);
    const job = await acceptJob(context, (await harness.repos.jobs.findByJobNumber('EJE-1048'))!);
    await addLabour(context, job, { date: today, rateType: 'double', hours: 1, description: 'Sunday' });
    await saveTimesheetComment(context, SIPHO, today, 'Sunday breakdown');
    await recordAttendance(harness.as(master), { userId: SIPHO, date: today, status: 'present', note: '' });

    const file = await exportTimesheet(harness.as(master), SIPHO, today, today);
    const [header, ...lines] = file.csv.replace(/^﻿/u, '').trim().split('\r\n');
    expect(header).toBe('Date,Customer,Jobs,Normal,OT,Dblt,Callout,Comments,Attendance');
    expect(lines.some((row) => row.includes('EJE-1048') && row.includes('Sunday breakdown') && row.endsWith('Present'))).toBe(true);
    expect(file.fileName).toMatch(/^eje-timesheet-sipho-mahlangu-.*\.csv$/u);
  });
});
