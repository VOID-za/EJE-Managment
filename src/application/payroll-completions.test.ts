import { beforeEach, describe, expect, it } from 'vitest';
import { asUserId, type TimesheetLineTyped } from '@/domain';
import { pdfPlainText } from '@/lib/pdf/inspect';
import { clearAttendance, loadMyAttendance, recordAttendance } from './attendance-operations';
import {
  checkFormCompletion,
  completePayrollForm,
  loadCompletedFormPdf,
  loadMyCompletedForms,
  sameContent,
  submitCompletedForms,
} from './payroll-completions';
import { listPayrollHistory } from './payroll-forms';
import { loadWorkingLines, removeTimesheetLine, saveTimesheetLine } from './timesheet-lines';
import { saveTimesheetEntry, saveWorkingTimesheetComment } from './timesheets';
import { buildHarness, seedUser, type Harness } from './test-harness';

/**
 * FORM-LIFECYCLE-1 (the owner, 6 November 2026): each form COMPLETED on its
 * own page — named, frozen, locked — and both SUBMITTED to the office together
 * from My Monthly Forms; Present and Absent toggle.
 */
const SIPHO = asUserId('user-tech-sipho');
const COORD = asUserId('user-coord-christene');
const sipho = seedUser('user-tech-sipho');
const riaan = seedUser('user-tech-riaan');
const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');
const clock = { at: '2026-11-26T06:00:00.000Z', now(): string { return this.at; } };
const FROM = '2026-11-01';
const TO = '2026-11-25';

let harness: Harness;
beforeEach(async () => {
  clock.at = '2026-11-26T06:00:00.000Z';
  harness = buildHarness({ clock });
});

const typed = (overtime: string, customerName = 'ABC Engineering'): TimesheetLineTyped => ({
  pick: '', customerName, overtime, double: '0', callout: '0', internalKm: '0', customerKm: '0',
});
const line = (date: string | null, value: TimesheetLineTyped, id: string = crypto.randomUUID(), expectedRevision: string | null = null) =>
  saveTimesheetLine(harness.as(sipho), SIPHO, { id, date, typed: value, expectedRevision });
const present = (date: string, who = sipho) => recordAttendance(harness.as(who), { userId: who.id, date, status: 'present', note: '' });
const complete = (kind: 'timesheet' | 'attendance', extra: { fileName?: string; from?: string; to?: string; who?: typeof sipho } = {}) =>
  completePayrollForm(harness.as(extra.who ?? sipho), (extra.who ?? sipho).id, {
    kind,
    from: extra.from ?? FROM,
    to: extra.to ?? TO,
    fileName: extra.fileName ?? '',
    confirmUnrecorded: true,
    confirmNoLines: true,
  });
const refusedWith = async (work: Promise<unknown>, code: string) => expect(work).rejects.toMatchObject({ violations: [{ code }] });
const stateOf = (who = sipho) => loadMyCompletedForms(harness.as(who), who.id);

describe('Attendance: Present and Absent toggle — pressed again, the day is Not recorded', () => {
  it('clears a Present or an Absent day; the day is not recorded (no row), never turned into the other answer; audited', async () => {
    await present('2026-11-03');
    expect(await clearAttendance(harness.as(sipho), { userId: SIPHO, date: '2026-11-03' })).toEqual({ cleared: true });
    expect(await harness.repos.attendance.findRecord(SIPHO, '2026-11-03')).toBeNull();
    await recordAttendance(harness.as(sipho), { userId: SIPHO, date: '2026-11-04', status: 'absent', absenceReason: 'leave', note: '' });
    await clearAttendance(harness.as(sipho), { userId: SIPHO, date: '2026-11-04' });
    expect(await harness.repos.attendance.findRecord(SIPHO, '2026-11-04')).toBeNull();
    const mine = await loadMyAttendance(harness.as(sipho), '2026-11-03', '2026-11-04');
    expect(mine.days.map((day) => day.record)).toEqual([null, null]);
    expect((await harness.repos.activity.list()).filter((event) => event.type === 'attendance_cleared')).toHaveLength(2);
    // Clearing a day that is not recorded is the same answer: nothing changes, nothing is refused.
    expect(await clearAttendance(harness.as(sipho), { userId: SIPHO, date: '2026-11-03' })).toEqual({ cleared: false });
  });

  it('a stale screen never clears a newer answer; another person’s day is refused', async () => {
    const saved = await present('2026-11-03');
    await recordAttendance(harness.as(sipho), { userId: SIPHO, date: '2026-11-03', status: 'absent', absenceReason: 'leave', note: '', expectedRecordedAt: saved.recordedAt });
    clock.at = '2026-11-26T06:00:01.000Z';
    await refusedWith(clearAttendance(harness.as(sipho), { userId: SIPHO, date: '2026-11-03', expectedRecordedAt: 'an-older-record' }), 'attendance_changed');
    await refusedWith(clearAttendance(harness.as(master), { userId: SIPHO, date: '2026-11-03' }), 'not_permitted');
    expect((await harness.repos.attendance.findRecord(SIPHO, '2026-11-03'))?.status).toBe('absent');
  });
});

describe('Completing a form: checked on the server, frozen under its name, locked', () => {
  it('the dialog’s check proposes the name, and says what stops it and what must be confirmed', async () => {
    await line('2026-11-05', typed('1.234'));
    const blocked = await checkFormCompletion(harness.as(sipho), SIPHO, 'timesheet', FROM, TO);
    expect(blocked.problems.join(' ')).toMatch(/not complete/u);
    expect(blocked.fileName).toMatch(/^SIPHO Timesheet Nov 2026\.pdf$/u);
    const attendance = await checkFormCompletion(harness.as(sipho), SIPHO, 'attendance', FROM, TO);
    expect(attendance.needs.confirmUnrecorded).toBe(true);
    expect(attendance.problems).toEqual([]);
  });

  it('completes the timesheet under the name chosen: content and PDF frozen, the comment taken, the dates locked; a second one is refused', async () => {
    const id = crypto.randomUUID();
    await line('2026-11-05', typed('2', 'Kruger'), id);
    await saveWorkingTimesheetComment(harness.as(sipho), SIPHO, 'Shutdown week.');
    const form = await complete('timesheet', { fileName: 'My November Sheet' });
    expect(form).toMatchObject({ kind: 'timesheet', from: FROM, to: TO, fileName: 'My November Sheet.pdf', submissionId: null, summary: '1 line' });
    const stored = (await harness.repos.payroll.findFormCompletion(form.id))!;
    expect(stored.timesheet?.comment).toBe('Shutdown week.');
    expect(stored.timesheet?.entries.map((entry) => entry.customerName)).toEqual(['Kruger']);
    expect((await harness.repos.attendance.findWorkingComment(SIPHO))?.comment ?? '').toBe('');
    const pdf = await loadCompletedFormPdf(harness.as(sipho), form.id);
    expect(pdf.fileName).toBe('My November Sheet.pdf');
    expect(await pdfPlainText(pdf.bytes)).toContain('Kruger');
    // Locked: every way of changing those dates is refused.
    const [held] = (await loadWorkingLines(harness.as(sipho), SIPHO)).filter((candidate) => candidate.id === id);
    expect(held?.completed).toEqual({ from: FROM, to: TO });
    await refusedWith(line('2026-11-05', typed('9', 'Kruger'), id, held!.revision), 'form_completed');
    await refusedWith(line('2026-11-06', typed('1')), 'form_completed');
    await refusedWith(removeTimesheetLine(harness.as(sipho), SIPHO, id), 'form_completed');
    await refusedWith(saveTimesheetEntry(harness.as(sipho), SIPHO, { date: '2026-11-07', customerName: 'X', overtimeHours: 1, doubleHours: 0 }), 'form_completed');
    // A line outside the dates is the next sheet's, and is open.
    await expect(line('2026-11-27', typed('1'))).resolves.toBeDefined();
    await refusedWith(complete('timesheet'), 'form_already_completed');
    expect((await harness.repos.payroll.listFormCompletions(SIPHO)).length).toBe(1);
  });

  it('completes the attendance; its days are locked against a change and a clear', async () => {
    await present('2026-11-03');
    await complete('attendance');
    await refusedWith(recordAttendance(harness.as(sipho), { userId: SIPHO, date: '2026-11-03', status: 'absent', absenceReason: 'leave', note: '' }), 'form_completed');
    await refusedWith(clearAttendance(harness.as(sipho), { userId: SIPHO, date: '2026-11-03' }), 'form_completed');
    expect((await loadMyAttendance(harness.as(sipho), '2026-11-03', '2026-11-03')).days[0]?.locked).toBe('completed');
  });

  it('refuses: an incomplete line, an absent day without its reason, unconfirmed unrecorded weekdays or no lines, an unsafe or duplicate name', async () => {
    const draft = crypto.randomUUID();
    await line('2026-11-05', typed('abc'), draft);
    await refusedWith(complete('timesheet'), 'timesheet_lines_incomplete');
    await removeTimesheetLine(harness.as(sipho), SIPHO, draft);
    await refusedWith(completePayrollForm(harness.as(sipho), SIPHO, { kind: 'timesheet', from: FROM, to: TO, fileName: '' }), 'timesheet_empty_unconfirmed');
    await refusedWith(completePayrollForm(harness.as(sipho), SIPHO, { kind: 'attendance', from: FROM, to: TO, fileName: '' }), 'attendance_incomplete');
    await refusedWith(complete('timesheet', { fileName: '../../etc/passwd' }), 'invalid_file_name');
    await complete('timesheet', { fileName: 'Same Name' });
    await refusedWith(complete('attendance', { fileName: 'Same Name' }), 'duplicate_file_name');
    expect((await harness.repos.payroll.listFormCompletions(SIPHO)).length).toBe(1);
  });

  it('nobody completes another person’s form; the Office completes no timesheet', async () => {
    await refusedWith(completePayrollForm(harness.as(master), SIPHO, { kind: 'attendance', from: FROM, to: TO, fileName: '', confirmUnrecorded: true }), 'not_permitted');
    await refusedWith(complete('timesheet', { who: coordinator }), 'timesheet_not_required');
  });

  it('the second form must be for the same dates as the first', async () => {
    await complete('timesheet');
    await refusedWith(complete('attendance', { from: '2026-11-02' }), 'form_period_mismatch');
    await expect(complete('attendance')).resolves.toMatchObject({ from: FROM, to: TO });
  });
});

describe('Submit to Office: both completed forms together, once — never one alone', () => {
  it('the four states of the button, said in words', async () => {
    expect(await stateOf()).toMatchObject({ readiness: 'none', readinessText: expect.stringContaining('Both forms must be completed') });
    await complete('timesheet');
    expect(await stateOf()).toMatchObject({ readiness: 'attendance_missing', readinessText: expect.stringContaining('Attendance form not completed') });
    await complete('attendance');
    expect(await stateOf()).toMatchObject({ readiness: 'ready', readinessText: expect.stringContaining('Ready to submit') });
    const other = buildHarness({ clock });
    await completePayrollForm(other.as(sipho), SIPHO, { kind: 'attendance', from: FROM, to: TO, fileName: '', confirmUnrecorded: true });
    expect(await loadMyCompletedForms(other.as(sipho), SIPHO)).toMatchObject({ readiness: 'timesheet_missing', readinessText: expect.stringContaining('Timesheet form not completed') });
  });

  it('the server refuses one form alone, and another person’s forms', async () => {
    await complete('timesheet');
    await refusedWith(submitCompletedForms(harness.as(sipho), SIPHO), 'submit_attendance_missing');
    await complete('attendance');
    await refusedWith(submitCompletedForms(harness.as(master), SIPHO), 'not_permitted');
    await refusedWith(submitCompletedForms(harness.as(riaan), SIPHO), 'not_permitted');
    expect(await harness.repos.payroll.listPayrollSubmissionsFor(SIPHO)).toEqual([]);
  });

  it('submits both as ONE submission under their completed names; both are marked; a second submit is refused', async () => {
    await line('2026-11-05', typed('2', 'Kruger'));
    await saveWorkingTimesheetComment(harness.as(sipho), SIPHO, 'Shutdown week.');
    await complete('timesheet', { fileName: 'Completed Sheet' });
    await complete('attendance', { fileName: 'Completed Attendance' });
    const submission = await submitCompletedForms(harness.as(sipho), SIPHO);
    expect(submission).toMatchObject({ from: FROM, to: TO, timesheetRequired: true, fileNames: { timesheet: 'Completed Sheet.pdf', attendance: 'Completed Attendance.pdf' } });
    expect(submission.documents.map((document) => document.kind)).toEqual(['timesheet', 'attendance']);
    const period = await harness.repos.attendance.findPeriodById(submission.timesheetPeriodId!);
    expect(period?.snapshot?.comment).toBe('Shutdown week.');
    expect((await harness.repos.payroll.listFormCompletions(SIPHO)).map((form) => form.submissionId)).toEqual([submission.id, submission.id]);
    expect(await stateOf()).toMatchObject({ readiness: 'none', timesheet: null, attendance: null });
    await refusedWith(submitCompletedForms(harness.as(sipho), SIPHO), 'payroll_already_submitted');
    expect((await listPayrollHistory(harness.as(sipho), SIPHO)).map((entry) => entry.id)).toEqual([submission.id]);
    // Submitted: read only — and never completed or submitted again.
    await refusedWith(present('2026-11-04'), 'form_submitted');
    await refusedWith(complete('attendance'), 'payroll_period_submitted');
  });

  it('a form changed after it was completed (somehow) is refused at Submit: nothing is submitted, both still wait', async () => {
    await present('2026-11-03');
    await complete('timesheet');
    await complete('attendance');
    // Written past the lock, as only a fault could: the record no longer matches the completed form.
    const record = (await harness.repos.attendance.findRecord(SIPHO, '2026-11-03'))!;
    await harness.repos.attendance.saveRecord({ ...record, status: 'absent', absenceReason: 'leave' });
    await refusedWith(submitCompletedForms(harness.as(sipho), SIPHO), 'payroll_form_changed');
    expect(await harness.repos.payroll.listPayrollSubmissionsFor(SIPHO)).toEqual([]);
    expect(await stateOf()).toMatchObject({ readiness: 'ready' });
  });

  it('the Office: attendance alone is ready, and goes alone', async () => {
    await present('2026-11-03', coordinator);
    expect(await stateOf(coordinator)).toMatchObject({ timesheetRequired: false, readiness: 'attendance_missing' });
    await complete('attendance', { who: coordinator });
    expect(await stateOf(coordinator)).toMatchObject({ readiness: 'ready' });
    const submission = await submitCompletedForms(harness.as(coordinator), COORD);
    expect(submission).toMatchObject({ timesheetRequired: false, timesheetPeriodId: null });
    expect(submission.documents.map((document) => document.kind)).toEqual(['attendance']);
  });

  it('another person’s completed form is not readable to a technician; the office reads it', async () => {
    const form = await complete('attendance');
    await refusedWith(loadCompletedFormPdf(harness.as(riaan), form.id), 'form_not_found');
    await expect(loadCompletedFormPdf(harness.as(master), form.id)).resolves.toMatchObject({ fileName: form.fileName });
    await refusedWith(loadMyCompletedForms(harness.as(riaan), SIPHO), 'not_permitted');
  });

  it('the next period starts the day after the forms completed or submitted', async () => {
    await complete('attendance');
    expect((await stateOf()).next.from).toBe('2026-11-26');
  });
});

describe('the review of 6 November 2026: a completed form read back from PostgreSQL', () => {
  /** What jsonb does to an object's keys: shortest first, then bytewise — never the order they were written in. */
  const asJsonb = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(asJsonb)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value as Record<string, unknown>)
              .sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
              .map((key) => [key, asJsonb((value as Record<string, unknown>)[key])]),
          )
        : value;

  it('is the same content as the live lines and days, whatever the order of its keys (it was refused as changed)', async () => {
    await line('2026-11-05', typed('2', 'Kruger'));
    await present('2026-11-03');
    await complete('timesheet');
    await complete('attendance');
    const [attendance, timesheet] = await Promise.all([
      harness.repos.payroll.listFormCompletions(SIPHO).then((forms) => forms.find((form) => form.kind === 'attendance')!),
      harness.repos.payroll.listFormCompletions(SIPHO).then((forms) => forms.find((form) => form.kind === 'timesheet')!),
    ]);
    const liveDays = attendance.attendance!;
    const liveEntries = timesheet.timesheet!.entries;
    expect(JSON.stringify(asJsonb(liveDays))).not.toBe(JSON.stringify(liveDays));
    expect(sameContent(asJsonb(liveDays), liveDays)).toBe(true);
    expect(sameContent(asJsonb(liveEntries), liveEntries)).toBe(true);
    // And a real difference is still a difference.
    expect(sameContent(asJsonb(liveDays), liveDays.map((day) => (day.date === '2026-11-03' ? { ...day, status: 'absent' } : day)))).toBe(false);
  });
});
