import { beforeEach, describe, expect, it } from 'vitest';
import { asUserId, type TimesheetLineTyped } from '@/domain';
import { pdfPlainText } from '@/lib/pdf/inspect';
import { clearAttendance, recordAttendance } from './attendance-operations';
import { assertDatesOpen, lockedRanges } from './form-locks';
import {
  checkFormCompletion,
  completePayrollForm,
  loadCompletedFormPdf,
  loadMyCompletedForms,
  submitCompletedForms,
  withdrawCompletedForm,
} from './payroll-completions';
import { listPayrollHistory } from './payroll-forms';
import { loadWorkingLines, removeTimesheetLine, saveTimesheetLine } from './timesheet-lines';
import { buildHarness, seedUser, type Harness } from './test-harness';

/**
 * FORM-WITHDRAW-1 (the owner, 6 November 2026): a completed form can be
 * withdrawn before Submit to Office — never after. The original stays exactly
 * as completed; a separate correction draft opens and must be completed again.
 *
 * And the lock rules of v1.7.1 (the owner's report of 6 November 2026, the
 * 31 October day shown as "In a submitted timesheet"): only the person's own
 * current forms lock their dates — never a past date as such, another
 * person's form, a replaced or a withdrawn one.
 */
const SIPHO = asUserId('user-tech-sipho');
const RIAAN = asUserId('user-tech-riaan');
const sipho = seedUser('user-tech-sipho');
const riaan = seedUser('user-tech-riaan');
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
const line = (date: string | null, value: TimesheetLineTyped, id: string = crypto.randomUUID(), expectedRevision: string | null = null, who = sipho) =>
  saveTimesheetLine(harness.as(who), who.id, { id, date, typed: value, expectedRevision });
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
const bytesOf = async (id: string) => (await loadCompletedFormPdf(harness.as(sipho), id)).bytes;

describe('Withdraw and Correct: before Submit to Office only — the original kept exactly as completed', () => {
  it('a completed timesheet is withdrawn: kept, PDF untouched, audited; a draft with its data opens, editable, and must be completed again', async () => {
    const id = crypto.randomUUID();
    const saved = await line('2026-11-05', typed('2.5', 'Test'), id);
    await present('2026-11-05');
    const original = await complete('timesheet', { fileName: 'Sipho November timesheet' });
    const pdfBefore = await bytesOf(original.id);
    const frozenBefore = await harness.repos.payroll.findFormCompletion(original.id);

    const withdrawn = await withdrawCompletedForm(harness.as(sipho), SIPHO, original.id);
    expect(withdrawn.withdrawnAt).toBe(clock.at);
    // The original: the same content and the same PDF, only marked withdrawn.
    const frozenAfter = await harness.repos.payroll.findFormCompletion(original.id);
    expect({ ...frozenAfter, withdrawnAt: undefined, withdrawnBy: undefined }).toEqual({ ...frozenBefore, withdrawnAt: undefined, withdrawnBy: undefined });
    expect(Buffer.from(await bytesOf(original.id)).equals(Buffer.from(pdfBefore))).toBe(true);
    const events = (await harness.repos.activity.list()).filter((event) => event.type === 'payroll_form_withdrawn');
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toMatch(/Kept exactly as it was completed/u);

    // The draft: the same lines, editable again; the name comes back.
    const state = await stateOf();
    expect(state.timesheet).toBeNull();
    expect(state.drafts.timesheet).toMatchObject({ from: FROM, to: TO, withdrawnFileName: 'Sipho November timesheet.pdf' });
    expect(state.corrections).toHaveLength(1);
    expect(state.corrections[0]).toMatchObject({ state: 'draft', kind: 'timesheet', replacement: null });
    expect(state.corrections[0]!.withdrawn.id).toBe(original.id);
    const lines = await loadWorkingLines(harness.as(sipho), SIPHO);
    expect(lines.find((row) => row.id === id)?.completed ?? null).toBeNull();
    await line('2026-11-05', typed('3', 'Test'), id, saved.revision);
    expect((await checkFormCompletion(harness.as(sipho), SIPHO, 'timesheet', FROM, TO)).fileName).toBe('Sipho November timesheet.pdf');

    // Completed again: a NEW frozen form, linked to the original; the original is never the one that counts.
    const replacement = await complete('timesheet');
    expect(replacement.id).not.toBe(original.id);
    expect(replacement.correctsId).toBe(original.id);
    const again = await stateOf();
    expect(again.timesheet?.id).toBe(replacement.id);
    expect(again.drafts.timesheet).toBeNull();
    expect(again.corrections[0]).toMatchObject({ state: 'completed' });
    expect(again.corrections[0]!.replacement?.id).toBe(replacement.id);
    expect(pdfPlainText(await bytesOf(replacement.id))).toMatch(/3\.00/u);
    expect(pdfPlainText(await bytesOf(original.id))).toMatch(/2\.50/u);
  });

  it('a completed attendance is withdrawn and corrected the same way', async () => {
    await present('2026-11-03');
    const original = await complete('attendance');
    await refusedWith(clearAttendance(harness.as(sipho), { userId: SIPHO, date: '2026-11-03' }), 'form_completed');
    await withdrawCompletedForm(harness.as(sipho), SIPHO, original.id);
    // The draft is editable: the day can be changed now.
    expect(await clearAttendance(harness.as(sipho), { userId: SIPHO, date: '2026-11-03' })).toEqual({ cleared: true });
    const replacement = await complete('attendance');
    expect(replacement.correctsId).toBe(original.id);
    expect(replacement.summary).not.toBe(original.summary);
    expect((await harness.repos.payroll.findFormCompletion(original.id))?.attendance?.find((day) => day.date === '2026-11-03')?.status).toBe('present');
  });

  it('refused: a submitted form, an already withdrawn one, another person’s, one that does not exist — nothing changes', async () => {
    await line('2026-11-05', typed('1'));
    await present('2026-11-05');
    const timesheet = await complete('timesheet');
    const attendance = await complete('attendance');
    await refusedWith(withdrawCompletedForm(harness.as(riaan), RIAAN, timesheet.id), 'form_not_found');
    await refusedWith(withdrawCompletedForm(harness.as(riaan), SIPHO, timesheet.id), 'not_permitted');
    await refusedWith(withdrawCompletedForm(harness.as(coordinator), SIPHO, timesheet.id), 'not_permitted');
    await refusedWith(withdrawCompletedForm(harness.as(sipho), SIPHO, 'no-such-form'), 'form_not_found');
    await withdrawCompletedForm(harness.as(sipho), SIPHO, timesheet.id);
    // Withdrawn twice — a retry or a second tab — is refused: one draft only.
    await refusedWith(withdrawCompletedForm(harness.as(sipho), SIPHO, timesheet.id), 'form_already_withdrawn');
    expect((await harness.repos.payroll.listCorrectionDrafts(SIPHO))).toHaveLength(1);
    // The other form, once submitted (with the corrected timesheet), is never withdrawn.
    await complete('timesheet');
    await submitCompletedForms(harness.as(sipho), SIPHO);
    await refusedWith(withdrawCompletedForm(harness.as(sipho), SIPHO, attendance.id), 'form_already_submitted');
    expect((await harness.repos.payroll.findFormCompletion(attendance.id))?.withdrawnAt ?? null).toBeNull();
  });

  it('two withdrawals at once make ONE withdrawal and one draft', async () => {
    await line('2026-11-05', typed('1'));
    const form = await complete('timesheet');
    const results = await Promise.allSettled([1, 2, 3].map(() => withdrawCompletedForm(harness.as(sipho), SIPHO, form.id)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await harness.repos.payroll.listCorrectionDrafts(SIPHO)).toHaveLength(1);
  });

  it('a correction keeps the dates of the form it corrects', async () => {
    await line('2026-11-05', typed('1'));
    const form = await complete('timesheet');
    await withdrawCompletedForm(harness.as(sipho), SIPHO, form.id);
    await refusedWith(complete('timesheet', { to: '2026-11-20' }), 'form_correction_period');
  });
});

describe('Submit to Office with a withdrawn form: only the current completed forms qualify', () => {
  it('a withdrawn original never satisfies the pair; the correction must be completed; then both go, once', async () => {
    await line('2026-11-05', typed('1'));
    await present('2026-11-05');
    const original = await complete('timesheet');
    await complete('attendance');
    expect((await stateOf()).readiness).toBe('ready');
    await withdrawCompletedForm(harness.as(sipho), SIPHO, original.id);
    const waiting = await stateOf();
    expect(waiting.readiness).toBe('timesheet_missing');
    expect(waiting.readinessText).toMatch(/withdrawn to correct it/u);
    await refusedWith(submitCompletedForms(harness.as(sipho), SIPHO), 'submit_timesheet_missing');
    const replacement = await complete('timesheet');
    expect((await stateOf()).readiness).toBe('ready');
    const submission = await submitCompletedForms(harness.as(sipho), SIPHO);
    expect((await harness.repos.payroll.findFormCompletion(replacement.id))?.submissionId).toBe(submission.id);
    // The withdrawn original never went in it.
    expect((await harness.repos.payroll.findFormCompletion(original.id))?.submissionId).toBeNull();
    expect((await harness.repos.payroll.markFormsSubmitted([original.id], submission.id))).toBe(0);
    expect((await stateOf()).corrections[0]).toMatchObject({ state: 'submitted' });
    // History has the submission once; the withdrawn form is not in it.
    const history = await listPayrollHistory(harness.as(sipho), SIPHO);
    expect(history.filter((entry) => entry.kind === 'period')).toHaveLength(1);
    await refusedWith(submitCompletedForms(harness.as(sipho), SIPHO), 'payroll_already_submitted');
  });

  it('a withdrawn form’s dates are open again, and the correction draft is the only form of its kind', async () => {
    await line('2026-11-05', typed('1'));
    const form = await complete('timesheet');
    expect((await lockedRanges(harness.as(sipho), SIPHO, 'timesheet')).map((range) => range.why)).toEqual(['completed']);
    await withdrawCompletedForm(harness.as(sipho), SIPHO, form.id);
    expect(await lockedRanges(harness.as(sipho), SIPHO, 'timesheet')).toEqual([]);
    await expect(assertDatesOpen(harness.as(sipho), SIPHO, 'timesheet', ['2026-11-05'])).resolves.toBeUndefined();
  });
});

describe('v1.7.1: only the person’s own current forms lock their dates', () => {
  it('a past date is not submitted as such: an active period with old dates stays editable until it is completed', async () => {
    clock.at = '2026-12-20T06:00:00.000Z';
    // 5 November is weeks ago; nothing was completed or submitted — it is editable.
    const id = crypto.randomUUID();
    const first = await line('2026-11-05', typed('1'), id);
    const second = await line('2026-11-05', typed('2'), id, first.revision);
    expect(second.typed.overtime).toBe('2');
    expect(await lockedRanges(harness.as(sipho), SIPHO, 'timesheet')).toEqual([]);
  });

  it('another person’s completed or submitted form never locks this person’s dates', async () => {
    await line('2026-11-05', typed('1'), undefined, null, riaan);
    await present('2026-11-05', riaan);
    await complete('timesheet', { who: riaan });
    await complete('attendance', { who: riaan });
    await submitCompletedForms(harness.as(riaan), RIAAN);
    expect(await lockedRanges(harness.as(sipho), SIPHO, 'timesheet')).toEqual([]);
    expect(await lockedRanges(harness.as(sipho), SIPHO, 'attendance')).toEqual([]);
    const mine = await line('2026-11-05', typed('4'));
    expect(mine.date).toBe('2026-11-05');
    await present('2026-11-05');
  });

  it('a completed form (awaiting) and an office-submitted one are told apart; the submitted one is read only', async () => {
    await line('2026-11-05', typed('1'));
    await present('2026-11-05');
    await complete('timesheet');
    expect((await lockedRanges(harness.as(sipho), SIPHO, 'timesheet')).map((range) => range.why)).toEqual(['completed']);
    await refusedWith(line('2026-11-06', typed('1')), 'form_completed');
    await complete('attendance');
    await submitCompletedForms(harness.as(sipho), SIPHO);
    const after = await lockedRanges(harness.as(sipho), SIPHO, 'timesheet');
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((range) => range.why === 'submitted')).toBe(true);
    await refusedWith(line('2026-11-06', typed('1')), 'form_submitted');
    // The next period, after it, is open.
    await line('2026-11-26', typed('1'));
  });

  it('a line left over on a date already sent (not in that timesheet) can be removed or moved off — never changed there', async () => {
    await line('2026-11-05', typed('1'));
    await present('2026-11-05');
    await complete('timesheet');
    await complete('attendance');
    await submitCompletedForms(harness.as(sipho), SIPHO);
    // Written straight into the store, as v1.6.0's resubmission allowed: a working line on a sent date.
    const stray = { ...(await harness.repos.attendance.listEntries(SIPHO, '2026-11-05', '2026-11-05'))[0]!, id: crypto.randomUUID(), overtimeHours: 9 };
    await harness.repos.attendance.saveEntry(stray);
    const shown = (await loadWorkingLines(harness.as(sipho), SIPHO)).find((row) => row.id === stray.id)!;
    expect(shown.submitted).toBeNull();
    // Changed in place: refused (the date was sent). Moved to an open date: allowed.
    await refusedWith(line('2026-11-05', typed('5'), stray.id, shown.revision), 'form_submitted');
    const moved = await line('2026-11-27', shown.typed, stray.id, shown.revision);
    expect(moved.date).toBe('2026-11-27');
    // A line IN the submitted timesheet is never removed or moved.
    const held = (await loadWorkingLines(harness.as(sipho), SIPHO)).find((row) => row.submitted !== null)!;
    await refusedWith(removeTimesheetLine(harness.as(sipho), SIPHO, held.id), 'timesheet_line_submitted');
    await refusedWith(line('2026-11-28', held.typed, held.id, held.revision), 'timesheet_line_submitted');
  });

  it('a stray line on a sent date is removed', async () => {
    await line('2026-11-05', typed('1'));
    await complete('timesheet');
    await present('2026-11-05');
    await complete('attendance');
    await submitCompletedForms(harness.as(sipho), SIPHO);
    const stray = { ...(await harness.repos.attendance.listEntries(SIPHO, '2026-11-05', '2026-11-05'))[0]!, id: crypto.randomUUID() };
    await harness.repos.attendance.saveEntry(stray);
    expect(await removeTimesheetLine(harness.as(sipho), SIPHO, stray.id)).toEqual({ removed: true });
    expect(await harness.repos.attendance.findEntry(stray.id)).toBeNull();
  });
});
