import { beforeEach, describe, expect, it } from 'vitest';
import { asUserId, type TimesheetLineTyped } from '@/domain';
import { sha256Hex } from '@/lib/job-card/document-identity';
import { pdfPlainText } from '@/lib/pdf/inspect';
import { recordAttendance } from './attendance-operations';
import { discardFinancePackage, loadPayrollMonth, prepareFinancePackage } from './finance-packages';
import {
  attendancePeriodDays,
  financeMonthOf,
  listPayrollHistory,
  loadPayrollFormDocument,
  loadPayrollForms,
  loadSubmittedPayrollDocument,
  renamePayrollDocument,
  submitPayrollForms,
  type SubmitPayrollFormsInput,
} from './payroll-forms';
import { loadWorkingLines, removeTimesheetLine, saveTimesheetLine } from './timesheet-lines';
import { loadSubmissionDocument, saveWorkingTimesheetComment, type TimesheetDocument } from './timesheets';
import { submitMonth } from './monthly-submissions';
import { buildHarness, seedUser, type Harness } from './test-harness';

/**
 * PAYROLL-ONE-1 (the owner, 5 November 2026) — Timesheets that save
 * themselves, My Monthly Forms as the one submission of BOTH forms for a
 * From–To period, stored PDF names, and cross-month and cross-year periods.
 */
const SIPHO = asUserId('user-tech-sipho');
const COORD = asUserId('user-coord-christene');
const sipho = seedUser('user-tech-sipho');
const riaan = seedUser('user-tech-riaan');
const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');
// 26 November 2026, 08:00 in Johannesburg.
const clock = { at: '2026-11-26T06:00:00.000Z', now(): string { return this.at; } };

let harness: Harness;
beforeEach(async () => {
  clock.at = '2026-11-26T06:00:00.000Z';
  harness = buildHarness({ clock });
  const settings = await harness.repos.settings.get();
  await harness.repos.settings.save({ ...settings, financeEmail: 'payroll@finance.example.test' });
});

const typed = (overtime: string, customerName = 'ABC Engineering', extra: Partial<TimesheetLineTyped> = {}): TimesheetLineTyped => ({
  pick: '', customerName, overtime, double: '0', callout: '0', internalKm: '0', customerKm: '0', ...extra,
});
const line = (date: string | null, value: TimesheetLineTyped, id: string = crypto.randomUUID(), expectedRevision: string | null = null) =>
  saveTimesheetLine(harness.as(sipho), SIPHO, { id, date, typed: value, expectedRevision });
const present = (date: string, who = sipho) => recordAttendance(harness.as(who), { userId: who.id, date, status: 'present', note: '' });
const formsOf = (from: string, to: string, who = sipho) => loadPayrollForms(harness.as(who), who.id, from, to);
/** Submits as My Monthly Forms does: the revision just read, the confirmations ticked unless said otherwise. */
const submit = async (from: string, to: string, options: Partial<SubmitPayrollFormsInput> = {}, who = sipho) => {
  const state = await formsOf(from, to, who);
  return submitPayrollForms(harness.as(who), who.id, {
    from, to, revision: state.revision, confirmUnrecorded: true, confirmNoLines: true, confirmReplace: false, ...options,
  });
};
const refusedWith = async (work: Promise<unknown>, code: string) => expect(work).rejects.toMatchObject({ violations: [{ code }] });
/**
 * A line in dates already submitted. FORM-LIFECYCLE-1 refuses typing it (`form_submitted`); one written there
 * before this release is in the register as a stored line, and is written so here.
 */
const lineInSubmittedDates = async (date: string, value: TimesheetLineTyped) => {
  await refusedWith(line(date, value), 'form_submitted');
  return harness.repos.attendance.saveEntry({
    id: crypto.randomUUID(), userId: SIPHO, date, customerId: null, customerName: value.customerName, workshop: false,
    normalHours: 0, overtimeHours: Number(value.overtime), doubleHours: 0, callouts: 0, calloutAmount: 0, calloutShared: false,
    internalKm: 0, customerKm: 0, updatedBy: SIPHO, updatedAt: clock.now(),
  });
};

describe('timesheet lines save themselves — complete lines stored, incomplete ones kept as drafts', () => {
  it('a complete line is stored under the id the screen gave it; a retry with the same values is one line', async () => {
    const id = crypto.randomUUID();
    const saved = await line('2026-11-03', typed('2'), id);
    expect(saved).toMatchObject({ id, complete: true, problems: [] });
    expect(saved.entry).toMatchObject({ id, overtimeHours: 2, customerName: 'ABC Engineering' });
    // A lost answer, retried from the same revision the screen had (null): no conflict, no second line.
    const again = await line('2026-11-03', typed('2'), id, null);
    expect(again.revision).toBe(saved.revision);
    expect(await harness.repos.attendance.listEntries(SIPHO, '2026-11-01', '2026-11-30')).toHaveLength(1);
  });

  it('an incomplete line is KEPT on the server as a draft with what it needs, survives a reload, and becomes the line when completed', async () => {
    const id = crypto.randomUUID();
    const draft = await line('2026-11-04', typed('1.234'), id);
    expect(draft.complete).toBe(false);
    expect(draft.entry).toBeNull();
    expect(draft.problems.map((problem) => problem.field)).toEqual(['overtime']);
    // A reload (or another device, or signing in again) shows exactly what was typed.
    const reloaded = (await loadWorkingLines(harness.as(sipho), SIPHO)).find((candidate) => candidate.id === id)!;
    expect(reloaded).toMatchObject({ complete: false, typed: typed('1.234'), date: '2026-11-04' });
    const fixed = await line('2026-11-04', typed('1.25'), id, draft.revision);
    expect(fixed).toMatchObject({ complete: true });
    expect(fixed.entry?.overtimeHours).toBe(1.25);
    expect(await harness.repos.attendance.findLineDraft(id)).toBeNull();
  });

  it('a stored line typed into something invalid keeps its last complete values until the draft is complete', async () => {
    const id = crypto.randomUUID();
    const first = await line('2026-11-05', typed('3'), id);
    const broken = await line('2026-11-05', typed('abc'), id, first.revision);
    expect(broken.complete).toBe(false);
    expect((await harness.repos.attendance.findEntry(id))?.overtimeHours).toBe(3);
    expect((await loadWorkingLines(harness.as(sipho), SIPHO)).find((candidate) => candidate.id === id)?.typed.overtime).toBe('abc');
  });

  it('an empty line, an undated line, an unknown customer and a day over 24 hours are drafts that say why', async () => {
    expect((await line('2026-11-06', typed('0', ''))).problems[0]?.message).toMatch(/^Empty line/u);
    expect((await line(null, typed('1'))).problems[0]?.field).toBe('date');
    expect((await line('2026-11-06', typed('1', 'X', { pick: '00000000-0000-4000-8000-0000000000ff' }))).problems[0]?.message).toMatch(/not in the register/u);
    await line('2026-11-07', typed('20'));
    const over = await line('2026-11-07', typed('5', 'Other'));
    expect(over.complete).toBe(false);
    expect(over.problems[0]?.message).toMatch(/more than 24/u);
    // The reload says the same thing — asked again by the server.
    expect((await loadWorkingLines(harness.as(sipho), SIPHO)).find((candidate) => candidate.id === over.id)?.problems[0]?.message).toMatch(/more than 24/u);
  });

  it('a save from an older revision is refused, never written over the newer line', async () => {
    const id = crypto.randomUUID();
    const first = await line('2026-11-08', typed('1'), id);
    clock.at = '2026-11-26T06:00:05.000Z';
    await line('2026-11-08', typed('2'), id, first.revision);
    await refusedWith(line('2026-11-08', typed('7'), id, first.revision), 'timesheet_line_changed');
    expect((await harness.repos.attendance.findEntry(id))?.overtimeHours).toBe(2);
  });

  it('only the owner writes; another person’s line id is refused like a missing one; a new id must be a real id', async () => {
    const mine = await line('2026-11-09', typed('1'));
    await refusedWith(saveTimesheetLine(harness.as(riaan), riaan.id, { id: mine.id, date: '2026-11-09', typed: typed('9'), expectedRevision: mine.revision }), 'entry_not_found');
    await refusedWith(saveTimesheetLine(harness.as(master), SIPHO, { id: crypto.randomUUID(), date: '2026-11-09', typed: typed('9'), expectedRevision: null }), 'not_permitted');
    await refusedWith(saveTimesheetLine(harness.as(sipho), SIPHO, { id: 'not-an-id', date: '2026-11-09', typed: typed('9'), expectedRevision: null }), 'entry_not_found');
    await refusedWith(saveTimesheetLine(harness.as(coordinator), COORD, { id: crypto.randomUUID(), date: '2026-11-09', typed: typed('1'), expectedRevision: null }), 'timesheet_not_required');
  });

  it('removing a line removes it and its draft; asked again it changes nothing; another person’s is untouched', async () => {
    const stored = await line('2026-11-10', typed('1'));
    await line('2026-11-10', typed('x'), stored.id, stored.revision);
    expect(await removeTimesheetLine(harness.as(sipho), SIPHO, stored.id)).toEqual({ removed: true });
    expect(await harness.repos.attendance.findEntry(stored.id)).toBeNull();
    expect(await harness.repos.attendance.findLineDraft(stored.id)).toBeNull();
    expect(await removeTimesheetLine(harness.as(sipho), SIPHO, stored.id)).toEqual({ removed: false });
    const draftOnly = await line(null, typed('1'));
    expect(await removeTimesheetLine(harness.as(sipho), SIPHO, draftOnly.id)).toEqual({ removed: true });
    const his = await line('2026-11-11', typed('1'));
    expect(await removeTimesheetLine(harness.as(riaan), riaan.id, his.id)).toEqual({ removed: false });
    expect(await harness.repos.attendance.findEntry(his.id)).not.toBeNull();
  });
});

describe('My Monthly Forms — both forms together for the period, once', () => {
  it('a CROSS-MONTH period: 24 Oct – 25 Nov 2026 holds both months, belongs to Finance November, and is frozen with its PDFs', async () => {
    for (const date of ['2026-10-23', '2026-10-24', '2026-11-25', '2026-11-26']) await line(date, typed('1', `L-${date}`));
    await present('2026-10-24');
    await present('2026-11-25');
    await saveWorkingTimesheetComment(harness.as(sipho), SIPHO, 'Two months.');
    const state = await formsOf('2026-10-24', '2026-11-25');
    expect(state).toMatchObject({ financeMonth: '2026-11', financeMonthLabel: 'November 2026', days: 33, timesheetRequired: true, canSubmit: true });
    expect(state.timesheet?.lineCount).toBe(2);
    expect(state.fileNames).toEqual({ timesheet: 'SIPHO Timesheet Nov 2026.pdf', attendance: 'SIPHO Atten Oct-Nov.pdf' });

    const submission = await submit('2026-10-24', '2026-11-25');
    expect(submission).toMatchObject({ from: '2026-10-24', to: '2026-11-25', financeMonth: '2026-11', timesheetRequired: true });
    expect(submission.attendance.days).toHaveLength(33);
    expect(submission.attendance.days.filter((day) => day.status === 'present').map((day) => day.date)).toEqual(['2026-10-24', '2026-11-25']);
    const period = (await harness.repos.attendance.findPeriodById(submission.timesheetPeriodId!))!;
    expect(period.snapshot?.entries.map((entry) => entry.customerName).sort()).toEqual(['L-2026-10-24', 'L-2026-11-25']);
    expect(period.snapshot?.comment).toBe('Two months.');
    expect(submission.documents.map((document) => [document.kind, document.fileName])).toEqual([
      ['timesheet', 'SIPHO Timesheet Nov 2026.pdf'],
      ['attendance', 'SIPHO Atten Oct-Nov.pdf'],
    ]);
    // The office was told once; it is on the trail.
    expect((await harness.repos.notifications.list(master.id)).filter((note) => note.type === 'timesheet_submitted')).toHaveLength(1);
    expect((await harness.repos.activity.list()).filter((event) => event.type === 'payroll_forms_submitted')).toHaveLength(1);
    // The lines outside stay on the sheet; the lines inside are shown as submitted, not editable.
    const lines = await loadWorkingLines(harness.as(sipho), SIPHO);
    expect(lines.filter((candidate) => candidate.submitted !== null).map((candidate) => candidate.date).sort()).toEqual(['2026-10-24', '2026-11-25']);
    const inside = lines.find((candidate) => candidate.date === '2026-11-25')!;
    await refusedWith(line('2026-11-25', typed('9'), inside.id, inside.revision), 'timesheet_line_submitted');
    await refusedWith(removeTimesheetLine(harness.as(sipho), SIPHO, inside.id), 'timesheet_line_submitted');
  });

  it('a CROSS-YEAR period: 16 Dec 2026 – 15 Jan 2027 belongs to Finance January 2027', async () => {
    clock.at = '2027-01-20T06:00:00.000Z';
    await line('2026-12-31', typed('1', 'L-NYE'));
    await line('2027-01-01', typed('1', 'L-NYD'));
    const submission = await submit('2026-12-16', '2027-01-15');
    expect(submission.financeMonth).toBe('2027-01');
    expect(submission.attendance.days[0]?.date).toBe('2026-12-16');
    expect(submission.attendance.days.at(-1)?.date).toBe('2027-01-15');
    expect(submission.fileNames.attendance).toBe('SIPHO Atten Dec 2026-Jan 2027.pdf');
    expect((await harness.repos.attendance.findPeriodById(submission.timesheetPeriodId!))?.snapshot?.entries).toHaveLength(2);
  });

  it('the period helpers: leap February, month and year ends, the Finance month of To', () => {
    expect(attendancePeriodDays('2028-02-01', '2028-02-29', [])).toHaveLength(29);
    expect(attendancePeriodDays('2027-02-27', '2027-03-01', []).map((day) => day.date)).toEqual(['2027-02-27', '2027-02-28', '2027-03-01']);
    expect(attendancePeriodDays('2026-12-31', '2027-01-01', []).map((day) => day.date)).toEqual(['2026-12-31', '2027-01-01']);
    expect(financeMonthOf('2026-11-25')).toBe('2026-11');
    expect(financeMonthOf('2027-01-01')).toBe('2027-01');
  });

  it('MONTH-END boundaries: 31 October is in October’s period and 1 November in the next — never both, never neither', async () => {
    await line('2026-10-31', typed('1', 'L-1031'));
    await line('2026-11-01', typed('1', 'L-1101'));
    const october = await submit('2026-10-01', '2026-10-31');
    const november = await submit('2026-11-01', '2026-11-25');
    const tags = async (id: string) => (await harness.repos.attendance.findPeriodById(id))!.snapshot!.entries.map((entry) => entry.customerName);
    expect(await tags(october.timesheetPeriodId!)).toEqual(['L-1031']);
    expect(await tags(november.timesheetPeriodId!)).toEqual(['L-1101']);
    expect([october.financeMonth, november.financeMonth]).toEqual(['2026-10', '2026-11']);
  });

  it('an INCOMPLETE line blocks the submission, named with what it needs; completed, the forms go', async () => {
    await line('2026-11-02', typed('2'));
    const broken = await line('2026-11-03', typed('0', ''));
    const state = await formsOf('2026-11-01', '2026-11-25');
    expect(state.canSubmit).toBe(false);
    expect(state.timesheet?.incomplete.map((item) => item.id)).toEqual([broken.id]);
    expect(state.problems[0]).toMatch(/Tue 3 Nov 2026 is not complete: Empty line/u);
    await refusedWith(submitPayrollForms(harness.as(sipho), SIPHO, { from: '2026-11-01', to: '2026-11-25', revision: state.revision, confirmUnrecorded: true }), 'timesheet_lines_incomplete');
    expect(await harness.repos.payroll.listPayrollSubmissionsFor(SIPHO)).toHaveLength(0);
    expect(await harness.repos.attendance.listSubmissions(SIPHO)).toHaveLength(0);
    await line('2026-11-03', typed('1'), broken.id, broken.revision);
    expect((await submit('2026-11-01', '2026-11-25')).timesheetPeriodId).not.toBeNull();
  });

  it('a draft with NO date blocks every period — it could be meant for any of them', async () => {
    await line(null, typed('1'));
    expect((await formsOf('2026-11-01', '2026-11-25')).canSubmit).toBe(false);
  });

  it('the absence reason, the unrecorded weekdays and an empty timesheet each need saying first', async () => {
    await harness.repos.attendance.saveRecord({
      id: 'att-x', userId: SIPHO, date: '2026-11-10', status: 'absent', absenceReason: null, note: '', recordedBy: SIPHO, recordedAt: '2026-11-10T08:00:00.000Z',
    });
    await refusedWith(submit('2026-11-01', '2026-11-25'), 'absence_reason_required');
    await recordAttendance(harness.as(sipho), { userId: SIPHO, date: '2026-11-10', status: 'absent', absenceReason: 'sick_leave', note: '' });
    await refusedWith(submit('2026-11-01', '2026-11-25', { confirmUnrecorded: false }), 'attendance_incomplete');
    await refusedWith(submit('2026-11-01', '2026-11-25', { confirmNoLines: false }), 'timesheet_empty_unconfirmed');
    // Confirmed: an EMPTY period is submitted, with a timesheet of no lines (it was required).
    const empty = await submit('2026-11-01', '2026-11-25');
    expect((await harness.repos.attendance.findPeriodById(empty.timesheetPeriodId!))?.snapshot?.entries).toEqual([]);
  });

  it('forms changed after they were opened are refused — never submitted unseen — and a stale retry cannot make a second submission', async () => {
    await line('2026-11-02', typed('2'));
    const seen = await formsOf('2026-11-01', '2026-11-25');
    await line('2026-11-04', typed('1'));
    const input = { from: '2026-11-01', to: '2026-11-25', revision: seen.revision, confirmUnrecorded: true };
    await refusedWith(submitPayrollForms(harness.as(sipho), SIPHO, input), 'payroll_forms_changed');
    const fresh = await formsOf('2026-11-01', '2026-11-25');
    await submitPayrollForms(harness.as(sipho), SIPHO, { ...input, revision: fresh.revision });
    // The same request again (a double tap that missed the idempotency key): the forms are no longer what it saw.
    await refusedWith(submitPayrollForms(harness.as(sipho), SIPHO, { ...input, revision: fresh.revision }), 'payroll_forms_changed');
    expect(await harness.repos.payroll.listPayrollSubmissionsFor(SIPHO)).toHaveLength(1);
  });

  it('only the person submits their own; the office reads but does not submit; another technician reads nothing', async () => {
    const state = await formsOf('2026-11-01', '2026-11-25', sipho);
    for (const actor of [master, coordinator, riaan]) {
      await refusedWith(submitPayrollForms(harness.as(actor), SIPHO, { from: '2026-11-01', to: '2026-11-25', revision: state.revision }), 'not_permitted');
    }
    expect((await loadPayrollForms(harness.as(master), SIPHO, '2026-11-01', '2026-11-25'))).toMatchObject({ owner: false, canSubmit: false });
    await refusedWith(loadPayrollForms(harness.as(riaan), SIPHO, '2026-11-01', '2026-11-25'), 'not_permitted');
    await refusedWith(listPayrollHistory(harness.as(riaan), SIPHO), 'not_permitted');
  });

  it('a person who keeps no timesheet submits ATTENDANCE ONLY — recorded as such, no empty timesheet created', async () => {
    await present('2026-11-02', coordinator);
    const state = await formsOf('2026-11-01', '2026-11-25', coordinator);
    expect(state).toMatchObject({ timesheetRequired: false, timesheet: null });
    const submission = await submit('2026-11-01', '2026-11-25', {}, coordinator);
    expect(submission).toMatchObject({ timesheetRequired: false, timesheetPeriodId: null, fileNames: { timesheet: '' } });
    expect(submission.documents.map((document) => document.kind)).toEqual(['attendance']);
    expect(await harness.repos.attendance.listSubmissions(COORD)).toHaveLength(0);
    const month = await loadPayrollMonth(harness.as(master), '2026-11');
    expect(month.rows.find((row) => row.technician.id === COORD)?.submissions[0]).toMatchObject({ type: 'Attendance only — no timesheet required', timesheetRequired: false });
  });
});

describe('overlaps and replacements — partial refused, complete replaced only when confirmed, the original kept', () => {
  it('the owner’s example: 1–31 October submitted, then 20 October – 20 November is REFUSED and nothing changes', async () => {
    await line('2026-10-15', typed('1'));
    await submit('2026-10-01', '2026-10-31');
    const before = [await harness.repos.payroll.listPayrollSubmissionsFor(SIPHO), await harness.repos.attendance.listSubmissions(SIPHO)];
    const state = await formsOf('2026-10-20', '2026-11-20');
    expect(state.partialOverlaps.map((overlap) => overlap.label)).toEqual(['forms Thu 1 Oct 2026 – Sat 31 Oct 2026']);
    await refusedWith(submit('2026-10-20', '2026-11-20', { confirmReplace: true }), 'payroll_partial_overlap');
    expect([await harness.repos.payroll.listPayrollSubmissionsFor(SIPHO), await harness.repos.attendance.listSubmissions(SIPHO)]).toEqual(before);
  });

  it('a COMPLETE replacement needs the confirmation; the original, its PDFs and names are kept and linked; Finance counts only the new one', async () => {
    await line('2026-11-05', typed('1', 'L-FIRST'));
    const first = await submit('2026-11-01', '2026-11-25');
    const firstPdf = await loadSubmittedPayrollDocument(harness.as(master), first.id, 'attendance');
    await lineInSubmittedDates('2026-11-06', typed('2', 'L-FORGOTTEN'));
    await refusedWith(submit('2026-11-01', '2026-11-25'), 'payroll_replace_unconfirmed');
    const second = await submit('2026-11-01', '2026-11-25', { confirmReplace: true });
    const kept = (await harness.repos.payroll.findPayrollSubmission(first.id))!;
    expect(kept).toMatchObject({ supersededBy: SIPHO, supersededBySubmission: second.id, documents: first.documents, fileNames: first.fileNames });
    expect(kept.supersededAt).not.toBeNull();
    // The original's stored PDF is exactly as it was.
    const again = await loadSubmittedPayrollDocument(harness.as(master), first.id, 'attendance');
    expect(again.sha256).toBe(firstPdf.sha256);
    // Its timesheet half too: replaced, kept, the snapshot untouched; the new one holds both lines.
    expect((await harness.repos.attendance.findPeriodById(first.timesheetPeriodId!))?.supersededAt).not.toBeNull();
    expect((await harness.repos.attendance.findPeriodById(first.timesheetPeriodId!))?.snapshot?.entries.map((entry) => entry.customerName)).toEqual(['L-FIRST']);
    expect((await harness.repos.attendance.findPeriodById(second.timesheetPeriodId!))?.snapshot?.entries.map((entry) => entry.customerName).sort()).toEqual(['L-FIRST', 'L-FORGOTTEN']);
    // Finance: one submission for November, the replacement.
    const month = await loadPayrollMonth(harness.as(master), '2026-11');
    expect(month.rows.find((row) => row.technician.id === SIPHO)?.submissions.map((submission) => submission.id)).toEqual([second.id]);
    const prepared = await prepareFinancePackage(harness.as(master), '2026-11', [SIPHO]);
    const timesheets = prepared.attachments.filter((attachment) => attachment.kind === 'timesheet');
    expect(timesheets).toHaveLength(1);
    const text = pdfPlainText((await harness.services.storage.getDocument(timesheets[0]!.storageKey))!.bytes);
    expect(text).toContain('L-FORGOTTEN');
    // The history keeps both.
    expect((await listPayrollHistory(harness.as(sipho), SIPHO)).map((entry) => [entry.id, entry.current])).toEqual([[second.id, true], [first.id, false]]);
  });

  it('several replacements in turn: each kept, only the last current; a wider period replaces two at once', async () => {
    await line('2026-11-05', typed('1'));
    const a = await submit('2026-11-01', '2026-11-10');
    const b = await submit('2026-11-11', '2026-11-20');
    const c = await submit('2026-11-01', '2026-11-25', { confirmReplace: true });
    const d = await submit('2026-10-26', '2026-11-25', { confirmReplace: true });
    const all = await harness.repos.payroll.listPayrollSubmissionsFor(SIPHO);
    expect(all.filter((submission) => submission.supersededAt === null).map((submission) => submission.id)).toEqual([d.id]);
    expect(all.find((submission) => submission.id === a.id)?.supersededBySubmission).toBe(c.id);
    expect(all.find((submission) => submission.id === b.id)?.supersededBySubmission).toBe(c.id);
    expect(all.find((submission) => submission.id === c.id)?.supersededBySubmission).toBe(d.id);
    expect((await harness.repos.attendance.listSubmittedPeriods(SIPHO, '2026-10-01', '2026-12-31')).map((period) => period.id)).toEqual([d.timesheetPeriodId]);
  });

  it('a month submitted before PAYROLL-ONE-1: cut by the dates, refused; covered by them, replaced on confirmation and kept', async () => {
    await present('2026-10-07');
    const legacy = await submitMonth(harness.as(sipho), SIPHO, '2026-10', { confirmUnrecorded: true });
    await refusedWith(submit('2026-10-20', '2026-11-20', { confirmReplace: true }), 'payroll_partial_overlap');
    const state = await formsOf('2026-09-26', '2026-11-25');
    expect(state.replaces.map((overlap) => overlap.kind)).toEqual(['monthly']);
    const covering = await submit('2026-09-26', '2026-11-25', { confirmReplace: true });
    const kept = (await harness.repos.payroll.findSubmission(SIPHO, '2026-10'))!;
    expect(kept).toMatchObject({ id: legacy.id, attendance: legacy.attendance, supersededBySubmission: covering.id });
    const month = await loadPayrollMonth(harness.as(master), '2026-10');
    expect(month.rows.find((row) => row.technician.id === SIPHO)?.status).toBe('not_submitted');
  });

  it('a corrected timesheet in the way is never replaced', async () => {
    const { requestTimesheetCorrection } = await import('./timesheet-corrections');
    const saved = await line('2026-11-05', typed('1'));
    await submit('2026-11-01', '2026-11-25');
    await requestTimesheetCorrection(harness.as(sipho), SIPHO, {
      from: '2026-11-01', to: '2026-11-25', reason: 'OT', comment: '',
      lines: [{ entryId: saved.id, date: '2026-11-05', customerName: 'ABC Engineering', overtimeHours: 2, doubleHours: 0 }],
    });
    await refusedWith(submit('2026-10-26', '2026-11-25', { confirmReplace: true }), 'timesheet_replace_corrected');
  });
});

describe('the PDFs’ names — stored, kept, used everywhere; never reaching a submitted document', () => {
  it('rename is kept on the server, used by the document and its PDF, refused when unsafe or the same as the other form, and is the owner’s only', async () => {
    await line('2026-11-05', typed('1'));
    expect(await renamePayrollDocument(harness.as(sipho), SIPHO, 'timesheet', 'Sipho November')).toEqual({ fileName: 'Sipho November.pdf', custom: true });
    // Renamed again: still one name.
    await renamePayrollDocument(harness.as(sipho), SIPHO, 'timesheet', 'Sipho Nov final');
    const state = await formsOf('2026-11-01', '2026-11-25');
    expect(state.fileNames.timesheet).toBe('Sipho Nov final.pdf');
    expect(state.customNames).toEqual({ timesheet: true, attendance: false });
    // Editing the form and changing the dates keep it: the name is the working document's, not the dates'.
    await line('2026-11-06', typed('1'));
    expect((await formsOf('2026-10-26', '2026-11-26')).fileNames.timesheet).toBe('Sipho Nov final.pdf');
    const document = await loadPayrollFormDocument(harness.as(sipho), SIPHO, 'timesheet', '2026-11-01', '2026-11-25');
    expect(document.fileName).toBe('Sipho Nov final.pdf');
    await refusedWith(renamePayrollDocument(harness.as(sipho), SIPHO, 'attendance', '../../etc/passwd'), 'invalid_file_name');
    await refusedWith(renamePayrollDocument(harness.as(sipho), SIPHO, 'attendance', 'SIPHO NOV FINAL'), 'duplicate_file_name');
    for (const actor of [master, riaan]) await refusedWith(renamePayrollDocument(harness.as(actor), SIPHO, 'attendance', 'x'), 'not_permitted');
    await refusedWith(renamePayrollDocument(harness.as(coordinator), COORD, 'timesheet', 'x'), 'timesheet_not_required');
    // Back to the default.
    await renamePayrollDocument(harness.as(sipho), SIPHO, 'timesheet', '');
    expect((await formsOf('2026-11-01', '2026-11-25')).fileNames.timesheet).toBe('SIPHO Timesheet Nov 2026.pdf');
  });

  it('renaming submits nothing, locks nothing and changes nothing in the document', async () => {
    const saved = await line('2026-11-05', typed('1'));
    const before = await loadPayrollFormDocument(harness.as(sipho), SIPHO, 'timesheet', '2026-11-01', '2026-11-25');
    await renamePayrollDocument(harness.as(sipho), SIPHO, 'timesheet', 'Mine');
    const after = await loadPayrollFormDocument(harness.as(sipho), SIPHO, 'timesheet', '2026-11-01', '2026-11-25');
    expect({ ...after, fileName: before.fileName }).toEqual(before);
    expect(await harness.repos.payroll.listPayrollSubmissionsFor(SIPHO)).toHaveLength(0);
    expect((await line('2026-11-05', typed('2'), saved.id, saved.revision)).complete).toBe(true);
  });

  it('the submitted documents keep the names they went with; renaming afterwards reaches only the next working document', async () => {
    await line('2026-11-05', typed('1'));
    await renamePayrollDocument(harness.as(sipho), SIPHO, 'timesheet', 'Sipho TS Nov');
    await renamePayrollDocument(harness.as(sipho), SIPHO, 'attendance', 'Sipho Att Nov');
    const submission = await submit('2026-11-01', '2026-11-25');
    expect(submission.fileNames).toEqual({ timesheet: 'Sipho TS Nov.pdf', attendance: 'Sipho Att Nov.pdf' });
    const stored = await loadSubmittedPayrollDocument(harness.as(sipho), submission.id, 'timesheet');
    // The working names went with the submission; the next forms start from the defaults.
    expect((await formsOf('2026-11-26', '2026-12-25')).customNames).toEqual({ timesheet: false, attendance: false });
    await renamePayrollDocument(harness.as(sipho), SIPHO, 'timesheet', 'Something else');
    const later = await loadSubmittedPayrollDocument(harness.as(sipho), submission.id, 'timesheet');
    expect([later.fileName, later.sha256]).toEqual(['Sipho TS Nov.pdf', stored.sha256]);
    expect((await harness.repos.payroll.findPayrollSubmission(submission.id))?.fileNames.timesheet).toBe('Sipho TS Nov.pdf');
    // Finance gets them under those names.
    const prepared = await prepareFinancePackage(harness.as(master), '2026-11', [SIPHO]);
    expect(prepared.attachments.map((attachment) => attachment.fileName).sort()).toEqual(['Sipho Att Nov.pdf', 'Sipho TS Nov.pdf']);
    await discardFinancePackage(harness.as(master), prepared.id);
  });

  it('a submitted document is read by its owner and the office only', async () => {
    const submission = await submit('2026-11-01', '2026-11-25');
    await expect(loadSubmittedPayrollDocument(harness.as(master), submission.id, 'attendance')).resolves.toBeDefined();
    await refusedWith(loadSubmittedPayrollDocument(harness.as(riaan), submission.id, 'attendance'), 'submission_not_found');
  });
});

describe('one document all the way: preview = PDF = snapshot = Finance', () => {
  it('the working preview is what is frozen, what is stored and what Finance receives', async () => {
    for (const [date, ot] of [['2026-10-30', '1.5'], ['2026-11-02', '2'], ['2026-11-24', '0.25']] as const) await line(date, typed(ot, `L-${date}`));
    await present('2026-11-02');
    const preview = (await loadPayrollFormDocument(harness.as(sipho), SIPHO, 'timesheet', '2026-10-26', '2026-11-25')) as TimesheetDocument;
    const submission = await submit('2026-10-26', '2026-11-25');
    const snapshot = (await harness.repos.attendance.findPeriodById(submission.timesheetPeriodId!))!.snapshot!;
    expect(preview.rows.map((row) => [row.date, row.customer, row.overtimeHours])).toEqual(
      snapshot.entries.map((entry) => [entry.date, entry.customerName, entry.overtimeHours]),
    );
    expect(preview.totals.overtimeHours).toBe(3.75);
    const submitted = await loadSubmissionDocument(harness.as(master), submission.timesheetPeriodId!);
    expect(submitted.rows).toEqual(preview.rows);
    expect(submitted.totals).toEqual(preview.totals);
    const prepared = await prepareFinancePackage(harness.as(master), '2026-11', [SIPHO]);
    const attendance = prepared.attachments.find((attachment) => attachment.kind === 'attendance')!;
    const stored = await loadSubmittedPayrollDocument(harness.as(master), submission.id, 'attendance');
    expect(attendance.sha256).toBe(stored.sha256);
    expect(attendance.sha256).toBe(await sha256Hex((await harness.services.storage.getDocument(attendance.storageKey))!.bytes));
    const sheet = prepared.attachments.find((attachment) => attachment.kind === 'timesheet')!;
    const text = pdfPlainText((await harness.services.storage.getDocument(sheet.storageKey))!.bytes);
    for (const tag of ['L-2026-10-30', 'L-2026-11-02', 'L-2026-11-24']) expect(text).toContain(tag);
    // A second package for the same month is refused while one is open: no duplicate.
    await refusedWith(prepareFinancePackage(harness.as(master), '2026-11', [SIPHO]), 'package_open');
  });
});

describe('the independent review’s findings (5 November 2026), fixed', () => {
  it('a stored line moved by a draft blocks the dates it would leave — its old copy is never frozen unseen', async () => {
    const stored = await line('2026-11-05', typed('1', 'L-MOVED'));
    // Moved to December and left incomplete: the stored copy is still dated 5 November.
    await line('2026-12-03', typed('abc', 'L-MOVED'), stored.id, stored.revision);
    const state = await formsOf('2026-11-01', '2026-11-25');
    expect(state.timesheet?.incomplete.map((item) => item.id)).toEqual([stored.id]);
    await refusedWith(submit('2026-11-01', '2026-11-25'), 'timesheet_lines_incomplete');
  });

  it('a draft left over a submitted line can always be discarded; the submitted line stays', async () => {
    const saved = await line('2026-11-05', typed('1'));
    await submit('2026-11-01', '2026-11-25');
    // As if a draft had been left over it before (never possible now through the screen).
    await harness.repos.attendance.saveLineDraft({ id: saved.id, userId: SIPHO, date: '2026-11-05', typed: typed('x'), updatedBy: SIPHO, updatedAt: clock.now() });
    expect((await loadWorkingLines(harness.as(sipho), SIPHO)).find((candidate) => candidate.id === saved.id)).toMatchObject({ complete: true, submitted: { from: '2026-11-01' } });
    expect(await removeTimesheetLine(harness.as(sipho), SIPHO, saved.id)).toEqual({ removed: true });
    expect(await harness.repos.attendance.findLineDraft(saved.id)).toBeNull();
    expect(await harness.repos.attendance.findEntry(saved.id)).not.toBeNull();
  });

  it('a replaced submission opened by its id shows ITS snapshot, not its same-dates replacement', async () => {
    await line('2026-11-05', typed('1', 'L-FIRST'));
    const first = await submit('2026-11-01', '2026-11-25');
    await lineInSubmittedDates('2026-11-06', typed('1', 'L-SECOND'));
    const second = await submit('2026-11-01', '2026-11-25', { confirmReplace: true });
    const original = await loadSubmissionDocument(harness.as(master), first.timesheetPeriodId!);
    expect(original.rows.map((row) => row.customer)).toEqual(['L-FIRST']);
    expect(original.versionLabel).toMatch(/replaced by a later submission/u);
    const replacement = await loadSubmissionDocument(harness.as(master), second.timesheetPeriodId!);
    expect(replacement.rows.map((row) => row.customer).sort()).toEqual(['L-FIRST', 'L-SECOND']);
  });

  it('both PDFs may not end up with one name, whichever way it came about', async () => {
    await line('2026-11-05', typed('1'));
    const defaults = (await formsOf('2026-11-01', '2026-11-25')).defaultNames;
    await renamePayrollDocument(harness.as(sipho), SIPHO, 'timesheet', defaults.attendance);
    const state = await formsOf('2026-11-01', '2026-11-25');
    expect(state.canSubmit).toBe(false);
    expect(state.problems.join(' ')).toMatch(/Both PDFs are called/u);
    await refusedWith(submit('2026-11-01', '2026-11-25'), 'payroll_forms_blocked');
  });

  it('days already SENT to Finance are never sent again by a replacement ending in another month; the same month may be corrected', async () => {
    const { sendFinancePackage } = await import('./finance-packages');
    await line('2026-10-05', typed('1'));
    await submit('2026-10-01', '2026-10-31');
    const prepared = await prepareFinancePackage(harness.as(master), '2026-10', [SIPHO]);
    await sendFinancePackage(harness.as(master), prepared.id);
    const across = await formsOf('2026-10-01', '2026-11-25');
    expect(across.problems.join(' ')).toMatch(/went to Finance in the October 2026 package/u);
    await refusedWith(submit('2026-10-01', '2026-11-25', { confirmReplace: true }), 'payroll_forms_blocked');
    // The same Finance month: allowed (later), and the office sees it as corrected after sending.
    clock.at = '2026-11-26T07:00:00.000Z';
    await submit('2026-09-28', '2026-10-31', { confirmReplace: true });
    const october = await loadPayrollMonth(harness.as(master), '2026-10');
    expect(october.rows.find((row) => row.technician.id === SIPHO)?.status).toBe('corrected_after_sent');
  });
});

describe('two devices, one line — PAYROLL-ONE-1 follow-ups (5 November 2026)', () => {
  it('save/save racing from one revision: exactly one is confirmed, the other refused explicitly; nothing is silently overwritten', async () => {
    for (let round = 0; round < 10; round += 1) {
      const first = await line('2026-11-10', typed('1', `RACE-${round}`));
      const results = await Promise.allSettled([
        line('2026-11-10', typed('2', `RACE-${round}`), first.id, first.revision),
        line('2026-11-10', typed('3', `RACE-${round}`), first.id, first.revision),
      ]);
      const confirmed = results.filter((result) => result.status === 'fulfilled');
      const refused = results.filter((result) => result.status === 'rejected');
      // When both arrive with the very same revision in the same millisecond, the second sees the first's
      // revision (the lock), so it is refused — unless it says exactly what the first saved (never here).
      expect(confirmed).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({ violations: [{ code: 'timesheet_line_changed' }] });
      const held = await harness.repos.attendance.findEntry(first.id);
      expect(held?.overtimeHours).toBe((confirmed[0] as PromiseFulfilledResult<{ entry: { overtimeHours: number } | null }>).value.entry?.overtimeHours);
      expect((await harness.repos.attendance.listEntries(SIPHO, '2026-11-10', '2026-11-10')).filter((entry) => entry.customerName === `RACE-${round}`)).toHaveLength(1);
      clock.at = new Date(Date.parse(clock.at) + 1000).toISOString();
    }
  });

  it('save/remove racing, in either order: a confirmed removal is never reversed, a save after it is refused saying what was typed', async () => {
    for (const order of ['remove-first', 'save-first'] as const) {
      const first = await line('2026-11-11', typed('1', `GONE-${order}`));
      const save = () => line('2026-11-11', typed('5', `GONE-${order}`), first.id, first.revision);
      const remove = () => removeTimesheetLine(harness.as(sipho), SIPHO, first.id);
      const results = order === 'remove-first' ? await Promise.allSettled([remove(), save()]) : await Promise.allSettled([save(), remove()]);
      expect(await harness.repos.attendance.findEntry(first.id)).toBeNull();
      expect(await harness.repos.attendance.findLineDraft(first.id)).toBeNull();
      if (order === 'remove-first') {
        expect((results[1] as PromiseRejectedResult).reason).toMatchObject({ violations: [{ code: 'timesheet_line_removed' }] });
        expect((results[1] as PromiseRejectedResult).reason.violations[0].message).toMatch(/What was typed: Wed 11 Nov 2026, GONE-remove-first, OT 5/u);
      }
      // Asked again later (a retry, a keepalive from a page left): still refused, still removed.
      await refusedWith(save(), 'timesheet_line_removed');
      expect(await harness.repos.attendance.findEntry(first.id)).toBeNull();
      clock.at = new Date(Date.parse(clock.at) + 1000).toISOString();
    }
  });

  it('a removal that arrives BEFORE the line\'s first save (a page left with both in the air) still wins', async () => {
    const id = crypto.randomUUID();
    expect(await removeTimesheetLine(harness.as(sipho), SIPHO, id)).toEqual({ removed: false });
    await refusedWith(line('2026-11-12', typed('1'), id, null), 'timesheet_line_removed');
    expect(await harness.repos.attendance.findEntry(id)).toBeNull();
    expect(await harness.repos.attendance.findLineDraft(id)).toBeNull();
  });

  it('removing somebody else\'s line id records nothing and blocks nothing for them', async () => {
    const his = await line('2026-11-13', typed('1'));
    expect(await removeTimesheetLine(harness.as(riaan), riaan.id, his.id)).toEqual({ removed: false });
    expect(await harness.repos.attendance.findLineRemoval(his.id)).toBeNull();
    expect((await line('2026-11-13', typed('2'), his.id, his.revision)).complete).toBe(true);
  });

  it('a retry and a refresh never make a second line', async () => {
    const id = crypto.randomUUID();
    await line('2026-11-14', typed('1', 'ONCE'), id, null);
    await line('2026-11-14', typed('1', 'ONCE'), id, null);
    const lines = (await loadWorkingLines(harness.as(sipho), SIPHO)).filter((candidate) => candidate.typed.customerName === 'ONCE');
    expect(lines).toHaveLength(1);
  });
});

describe('the second autosave review (5 November 2026), fixed', () => {
  it('REVIEW #4a: a draft typed back to the stored values still moves the revision on — an older copy elsewhere is refused', async () => {
    const stored = await line('2026-11-15', typed('2'));
    clock.at = new Date(Date.parse(clock.at) + 1000).toISOString();
    const draft = await line('2026-11-15', typed('abc'), stored.id, stored.revision);
    const back = await line('2026-11-15', typed('2'), stored.id, draft.revision);
    expect(back.complete).toBe(true);
    expect(back.revision > draft.revision).toBe(true);
    await refusedWith(line('2026-11-15', typed('7'), stored.id, stored.revision), 'timesheet_line_changed');
  });

  it('REVIEW #4b: a line written back after its removal (an earlier release, after a rollback) can be changed again', async () => {
    const first = await line('2026-11-16', typed('1', 'BACK'));
    await removeTimesheetLine(harness.as(sipho), SIPHO, first.id);
    // What v1.5.0 would do against a database at 0053: write the id again, knowing nothing of the removal.
    await harness.repos.attendance.saveEntry({ ...first.entry!, updatedAt: clock.now() });
    const again = (await loadWorkingLines(harness.as(sipho), SIPHO)).find((candidate) => candidate.id === first.id)!;
    expect((await line('2026-11-16', typed('3', 'BACK'), first.id, again.revision)).complete).toBe(true);
  });
});
