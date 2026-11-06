import { beforeEach, describe, expect, it } from 'vitest';
import { asUserId, type TimesheetEntry } from '@/domain';
import { weekdayOf } from '@/lib/timesheet-dates';
import {
  listTimesheetSubmissions,
  loadSubmissionDocument,
  loadWorkingTimesheet,
  removeTimesheetEntry,
  saveTimesheetEntry,
  saveWorkingTimesheetComment,
  submitTimesheetPeriod,
} from './timesheets';
import { decideTimesheetCorrection, requestTimesheetCorrection } from './timesheet-corrections';
import { buildHarness, seedUser, type Harness } from './test-harness';

/**
 * TS-PAPER — THE OWNER'S TWENTY REAL-WORLD SCENARIOS (4 November 2026).
 *
 * "The technician maintains it. The technician submits it on payday. EJE
 * records and preserves it." Each scenario below is one of the owner's,
 * numbered as in the instruction, on the real calendar: the clock is set to
 * the day the technician would be doing it (South African morning).
 */
const SIPHO = asUserId('user-tech-sipho');
const sipho = seedUser('user-tech-sipho');
const riaan = seedUser('user-tech-riaan');
const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');

const clock = { at: '2026-11-04T06:00:00.000Z', now(): string { return this.at; } };
/** The business day the clock says it is. */
const onDay = (date: string) => { clock.at = `${date}T06:00:00.000Z`; };

let harness: Harness;
beforeEach(() => {
  harness = buildHarness({ clock });
  onDay('2026-11-04');
});

const line = (date: string, overrides: Partial<Parameters<typeof saveTimesheetEntry>[2]> = {}) => ({
  date, customerName: 'ABC Engineering', overtimeHours: 1.5, doubleHours: 0, calloutAmount: 0, internalKm: 0, customerKm: 0, ...overrides,
});
const add = (date: string, overrides: Partial<Parameters<typeof saveTimesheetEntry>[2]> = {}) =>
  saveTimesheetEntry(harness.as(sipho), SIPHO, line(date, overrides));
const working = () => loadWorkingTimesheet(harness.as(sipho), SIPHO);
const submit = (from: string, to: string) => submitTimesheetPeriod(harness.as(sipho), SIPHO, from, to);

describe('TS-PAPER — the working timesheet, like the paper one', () => {
  it('1–2. one day entered and saved; the next day the technician comes back and continues', async () => {
    onDay('2026-10-27');
    const first = await add('2026-10-27');
    expect((await working()).entries.map((entry) => entry.id)).toEqual([first.id]);
    onDay('2026-10-28');
    const second = await add('2026-10-28', { customerName: 'Vaal Steel' });
    const sheet = await working();
    expect(sheet.entries.map((entry) => entry.id)).toEqual([first.id, second.id]);
    expect(sheet.suggested).toEqual({ from: '2026-10-27', to: '2026-10-28' });
  });

  it('3, 14. several entries on one day — several customers, and the same customer twice', async () => {
    await add('2026-11-03', { customerName: 'ABC Engineering', overtimeHours: 2 });
    await add('2026-11-03', { customerName: 'Vaal Steel', overtimeHours: 1 });
    await add('2026-11-03', { customerName: 'Vaal Steel', overtimeHours: 0.5, customerKm: 40 });
    const sheet = await working();
    expect(sheet.entries.filter((entry) => entry.date === '2026-11-03').map((entry) => entry.customerName)).toEqual(['ABC Engineering', 'Vaal Steel', 'Vaal Steel']);
  });

  it('4. Workshop without a customer — and a line with no customer at all', async () => {
    const workshop = await add('2026-11-03', { customerName: '', workshop: true, overtimeHours: 3, internalKm: 12 });
    expect(workshop).toMatchObject({ workshop: true, customerId: null, customerName: '', overtimeHours: 3, internalKm: 12 });
    const neither = await add('2026-11-03', { customerName: '', overtimeHours: 1 });
    expect(neither).toMatchObject({ workshop: false, customerName: '' });
  });

  it('5. a date outside the current pay period: before it is recorded; inside one already submitted is refused (FORM-LIFECYCLE-1)', async () => {
    onDay('2026-10-25');
    await add('2026-10-20');
    await submit('2026-09-26', '2026-10-25');
    onDay('2026-11-04');
    // A day of the submitted period: read only now — a forgotten line is a correction of that timesheet.
    await expect(add('2026-10-10')).rejects.toMatchObject({ violations: [{ code: 'form_submitted' }] });
    const ancient = await add('2026-01-15');
    const sheet = await working();
    expect(sheet.suggested.from).toBe('2026-10-26');
    expect(sheet.entries.map((entry) => entry.date)).not.toContain('2026-10-10');
    expect(sheet.entries.find((entry) => entry.id === ancient.id)?.outsideSubmitted).toBeNull();
  });

  it('6. a future date', async () => {
    const future = await add('2026-12-20', { customerName: 'Planned shutdown' });
    expect(future.date).toBe('2026-12-20');
    expect((await working()).entries.map((entry) => entry.date)).toContain('2026-12-20');
  });

  it('7. a timesheet longer than 92 days is kept and submitted', async () => {
    onDay('2026-11-25');
    await add('2026-08-03');
    await add('2026-09-15');
    await add('2026-11-24');
    const sent = await submit('2026-08-01', '2026-11-25');
    expect(sent.snapshot?.entries).toHaveLength(3);
    expect((Date.parse('2026-11-25') - Date.parse('2026-08-01')) / 86_400_000 + 1).toBe(117);
  });

  it('15. an entry corrected and one removed before submission: the submission holds what stands', async () => {
    const entry = await add('2026-11-02');
    const gone = await add('2026-11-03');
    await saveTimesheetEntry(harness.as(sipho), SIPHO, { ...line('2026-11-02', { overtimeHours: 4 }), entryId: entry.id });
    await removeTimesheetEntry(harness.as(sipho), SIPHO, gone.id);
    const sent = await submit('2026-10-26', '2026-11-04');
    expect(sent.snapshot?.entries.map((kept) => [kept.id, kept.overtimeHours])).toEqual([[entry.id, 4]]);
  });
});

describe('TS-PAPER — submitting on the real payday', () => {
  /** A first submission that ends on `to`, so the next period starts the day after. */
  const paidUpTo = async (to: string) => {
    onDay(to);
    await add(to, { customerName: 'Earlier period' });
    await submit('2026-01-01', to);
  };

  it('8, 16. a normal 25th-to-25th period, then the next one starts the day after', async () => {
    await paidUpTo('2026-10-25');
    onDay('2026-11-10');
    await add('2026-11-10');
    onDay('2026-11-25');
    await add('2026-11-25');
    await add('2026-11-26', { customerName: 'After payday' });
    let sheet = await working();
    expect(sheet.suggested).toEqual({ from: '2026-10-26', to: '2026-11-25' });
    const sent = await submit(sheet.suggested.from, sheet.suggested.to);
    expect(sent.snapshot?.entries.map((entry) => entry.date)).toEqual(['2026-11-10', '2026-11-25']);
    sheet = await working();
    // The next sheet: from the day after, the line after payday already on it.
    expect(sheet.suggested.from).toBe('2026-11-26');
    expect(sheet.entries.map((entry) => entry.date)).toEqual(['2026-11-26']);
    expect(sheet.lastSubmission).toMatchObject({ from: '2026-10-26', to: '2026-11-25' });
  });

  it('9. the 25th is a Saturday: paid, and submitted, on Monday the 27th', async () => {
    expect(weekdayOf('2027-09-25')).toBe('Sat');
    onDay('2027-08-25');
    await add('2027-08-25');
    await submit('2027-07-26', '2027-08-25');
    await add('2027-09-24');
    onDay('2027-09-27');
    expect(weekdayOf('2027-09-27')).toBe('Mon');
    await add('2027-09-27', { customerName: 'Monday morning' });
    const sheet = await working();
    expect(sheet.suggested).toEqual({ from: '2027-08-26', to: '2027-09-27' });
    const sent = await submit(sheet.suggested.from, sheet.suggested.to);
    expect(sent.to).toBe('2027-09-27');
    expect((await working()).suggested.from).toBe('2027-09-28');
  });

  it('10–11. December: paid early on the 15th; the next sheet runs 16 December to 25 January', async () => {
    await paidUpTo('2026-11-25');
    await add('2026-12-01');
    onDay('2026-12-15');
    await add('2026-12-15');
    await add('2026-12-18', { customerName: 'After the office closed' });
    let sheet = await working();
    expect(sheet.suggested).toEqual({ from: '2026-11-26', to: '2026-12-15' });
    const december = await submit('2026-11-26', '2026-12-15');
    expect(december.snapshot?.entries.map((entry) => entry.date)).toEqual(['2026-12-01', '2026-12-15']);
    onDay('2027-01-25');
    await add('2027-01-20');
    sheet = await working();
    expect(sheet.suggested).toEqual({ from: '2026-12-16', to: '2027-01-25' });
    const january = await submit(sheet.suggested.from, sheet.suggested.to);
    expect(january.snapshot?.entries.map((entry) => entry.date)).toEqual(['2026-12-18', '2027-01-20']);
  });

  it('12. paid early in an ordinary month (the finance administrator travels): submitted on the 18th', async () => {
    await paidUpTo('2027-02-25');
    onDay('2027-03-18');
    await add('2027-03-17');
    const sheet = await working();
    expect(sheet.suggested).toEqual({ from: '2027-02-26', to: '2027-03-18' });
    expect((await submit(sheet.suggested.from, '2027-03-18')).to).toBe('2027-03-18');
    expect((await working()).suggested.from).toBe('2027-03-19');
  });

  it('13. paid late (the finance administrator is away): lines keep coming after the 25th until it is submitted', async () => {
    await paidUpTo('2027-04-25');
    onDay('2027-05-25');
    await add('2027-05-25');
    onDay('2027-06-02');
    await add('2027-05-29');
    await add('2027-06-01');
    const sheet = await working();
    expect(sheet.suggested).toEqual({ from: '2027-04-26', to: '2027-06-02' });
    const sent = await submit(sheet.suggested.from, sheet.suggested.to);
    expect(sent.snapshot?.entries.map((entry) => entry.date)).toEqual(['2027-05-25', '2027-05-29', '2027-06-01']);
  });
});

describe('TS-PAPER — what the office receives, and how it is corrected', () => {
  it('17. the office sees exactly the submitted snapshot — and later work changes nothing in it', async () => {
    const entry = await add('2026-11-02', { overtimeHours: 2, calloutAmount: 45000, internalKm: 10, customerKm: 37.5 });
    await saveWorkingTimesheetComment(harness.as(sipho), SIPHO, 'Shutdown week.');
    const sent = await submit('2026-10-26', '2026-11-04');
    // Later work cannot reach it: the submitted dates are read only (FORM-LIFECYCLE-1).
    await expect(saveTimesheetEntry(harness.as(sipho), SIPHO, { ...line('2026-11-02', { overtimeHours: 9 }), entryId: entry.id })).rejects.toMatchObject({
      violations: [{ code: 'form_submitted' }],
    });
    const listed = await listTimesheetSubmissions(harness.as(master));
    expect(listed.map((row) => [row.id, row.technicianName, row.from, row.to, row.lineCount, row.current])).toEqual([
      [sent.id, 'Sipho Mahlangu', '2026-10-26', '2026-11-04', 1, true],
    ]);
    const document = await loadSubmissionDocument(harness.as(coordinator), sent.id);
    expect(document.comment).toBe('Shutdown week.');
    expect(document.submittedAt).toBe(sent.submittedAt);
    expect(document.rows.map((row) => [row.overtimeHours, row.calloutAmount, row.internalKm, row.customerKm])).toEqual([[2, 45000, 10, 37.5]]);
  });

  it('18. an authorised correction changes what is in force, and the original submission is kept intact', async () => {
    const entry = await add('2026-11-02', { overtimeHours: 2 });
    const sent = await submit('2026-10-26', '2026-11-04');
    const correction = await requestTimesheetCorrection(harness.as(sipho), SIPHO, {
      from: '2026-10-26', to: '2026-11-04', reason: 'OT was 3 hours', comment: '',
      lines: [{ ...line('2026-11-02', { overtimeHours: 3 }), entryId: entry.id }],
    });
    await decideTimesheetCorrection(harness.as(coordinator), SIPHO, correction.id, { decision: 'accept' });
    expect((await loadSubmissionDocument(harness.as(master), sent.id)).rows[0]?.overtimeHours).toBe(3);
    const original = await loadSubmissionDocument(harness.as(master), sent.id, 'original');
    expect(original.rows[0]?.overtimeHours).toBe(2);
    expect(original.versionLabel).toMatch(/superseded by an accepted correction/u);
    const stored = await harness.repos.attendance.findPeriodById(sent.id);
    expect(stored?.snapshot).toEqual(sent.snapshot);
    expect((await listTimesheetSubmissions(harness.as(master)))[0]?.versionInForce).toMatch(/^Correction 1, accepted/u);
  });

  it('19. historical records stay exactly as they were: NT and call-out counts are never converted; old submissions untouched', async () => {
    const old: TimesheetEntry = {
      id: 'tse-historical', userId: SIPHO, date: '2026-10-20', customerId: null, customerName: 'Kruger', workshop: false,
      normalHours: 8, overtimeHours: 0, doubleHours: 0, callouts: 2, calloutAmount: 0, calloutShared: true,
      internalKm: 0, customerKm: 0, updatedBy: SIPHO, updatedAt: '2026-10-20T08:00:00.000Z',
    };
    await harness.repos.attendance.saveEntry(old);
    const sheet = await working();
    expect(sheet.entries.find((entry) => entry.id === old.id)).toMatchObject({ normalHours: 8, callouts: 2, overtimeHours: 0, doubleHours: 0, calloutAmount: 0, calloutShared: true });
    const sent = await submit('2026-10-01', '2026-10-31');
    expect(sent.snapshot?.entries[0]).toMatchObject({ normalHours: 8, callouts: 2, overtimeHours: 0, calloutAmount: 0 });
    const document = await loadSubmissionDocument(harness.as(master), sent.id);
    expect(document.totals).toMatchObject({ historicalNormalHours: 8, historicalCallouts: 2, overtimeHours: 0, doubleHours: 0, calloutAmount: 0 });
    // A later, separate submission leaves the earlier one exactly as stored.
    await add('2026-11-03');
    await submit('2026-11-01', '2026-11-04');
    const kept = await harness.repos.attendance.findPeriodById(sent.id);
    expect(kept?.snapshot).toEqual(sent.snapshot);
    expect(kept?.supersededAt ?? null).toBeNull();
  });

  it('20. another technician cannot open somebody else’s working timesheet or submissions', async () => {
    await add('2026-11-02');
    const sent = await submit('2026-10-26', '2026-11-04');
    await expect(loadWorkingTimesheet(harness.as(riaan), SIPHO)).rejects.toMatchObject({ violations: [{ code: 'not_permitted' }] });
    await expect(listTimesheetSubmissions(harness.as(riaan), SIPHO)).rejects.toMatchObject({ violations: [{ code: 'not_permitted' }] });
    expect(await listTimesheetSubmissions(harness.as(riaan))).toEqual([]);
    await expect(loadSubmissionDocument(harness.as(riaan), sent.id)).rejects.toMatchObject({ violations: [{ code: 'submission_not_found' }] });
    await expect(saveTimesheetEntry(harness.as(riaan), SIPHO, line('2026-11-02'))).rejects.toMatchObject({ violations: [{ code: 'not_permitted' }] });
    await expect(saveWorkingTimesheetComment(harness.as(riaan), SIPHO, 'x')).rejects.toMatchObject({ violations: [{ code: 'not_permitted' }] });
    await expect(submitTimesheetPeriod(harness.as(master), SIPHO, '2026-11-05', '2026-11-06')).rejects.toMatchObject({ violations: [{ code: 'not_permitted' }] });
  });
});
