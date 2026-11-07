/**
 * THE PAYROLL COMPLETION AUDIT (5 November 2026), each finding proved fixed.
 *
 *   F1  a Finance package is sent only while it is still what is current: a
 *       submission made, replaced or corrected between Prepare and Send is
 *       refused, never missed; "sent" means what the package carried.
 *   F2  a calendar-month attendance submitted before PAYROLL-ONE-1 goes to
 *       Finance AS SUBMITTED, never as the register stands now.
 *   F3  the office reads a technician's timesheet; it never writes its comment.
 *   F4  a PDF name Windows keeps for itself is refused with any extension.
 *   D1  a submitted timesheet's PDF keeps the name it was submitted under,
 *       wherever it is opened.
 *   M4  attendance days changed in the register after a period was submitted
 *       are told to the office.
 */
import { describe, expect, it } from 'vitest';
import { asUserId } from '@/domain';
import { recordAttendance } from '@/application/attendance-operations';
import { discardFinancePackage, loadFinancePackageFile, loadPayrollMonth, prepareFinancePackage, sendFinancePackage } from '@/application/finance-packages';
import { submitMonth } from '@/application/monthly-submissions';
import { listPayrollHistory, loadPayrollForms, renamePayrollDocument, submitPayrollForms } from '@/application/payroll-forms';
import { saveTimesheetLine } from '@/application/timesheet-lines';
import { loadSubmissionDocument, saveTimesheetComment } from '@/application/timesheets';
import { buildHarness, seedUser } from '@/application/test-harness';
import { normalisePdfFileName } from '@/lib/pdf-file-name';
import { pdfPlainText } from '@/lib/pdf/inspect';

const SIPHO = asUserId('user-tech-sipho');
const sipho = seedUser('user-tech-sipho');
const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');
const clock = { at: '2026-11-26T06:00:00.000Z', now(): string { return this.at; } };
const typed = (overtime: string) => ({ pick: '', customerName: 'Audit Customer', overtime, double: '0', callout: '0', internalKm: '0', customerKm: '0' });

const setup = async () => {
  clock.at = '2026-11-26T06:00:00.000Z';
  const harness = buildHarness({ clock });
  const settings = await harness.repos.settings.get();
  await harness.repos.settings.save({ ...settings, financeEmail: 'payroll@finance.example.test' });
  const submit = async (from: string, to: string, confirmReplace = false) => {
    const state = await loadPayrollForms(harness.as(sipho), SIPHO, from, to);
    return submitPayrollForms(harness.as(sipho), SIPHO, { from, to, revision: state.revision, confirmUnrecorded: true, confirmNoLines: true, confirmReplace });
  };
  const later = (minutes: number) => {
    clock.at = new Date(Date.parse(clock.at) + minutes * 60_000).toISOString();
  };
  const row = async () => (await loadPayrollMonth(harness.as(master), '2026-11')).rows.find((candidate) => candidate.technician.id === SIPHO)!;
  return { harness, submit, later, row };
};

const refusedWith = async (promise: Promise<unknown>, code: string) =>
  expect(promise).rejects.toMatchObject({ violations: [expect.objectContaining({ code })] });

describe('F1: a Finance package never sends what is no longer current', () => {
  it('a second submission made between Prepare and Send: Send is refused, nothing is sent; prepared again, both periods go', async () => {
    const { harness, submit, later, row } = await setup();
    await submit('2026-11-01', '2026-11-10');
    const stale = await prepareFinancePackage(harness.as(master), '2026-11', [SIPHO]);
    later(60);
    await submit('2026-11-11', '2026-11-25');
    await refusedWith(sendFinancePackage(harness.as(master), stale.id), 'package_out_of_date');
    expect((await harness.repos.payroll.findPackage(stale.id))?.status).toBe('prepared');
    await discardFinancePackage(harness.as(master), stale.id);
    const fresh = await prepareFinancePackage(harness.as(master), '2026-11', [SIPHO]);
    expect(fresh.attachments.filter((attachment) => attachment.kind === 'attendance')).toHaveLength(2);
    const sent = await sendFinancePackage(harness.as(master), fresh.id);
    expect(sent.status).toBe('sent');
    expect((await row()).status).toBe('sent');
  });

  it('a same-dates replacement between Prepare and Send: refused — the replaced submission is never sent in its place', async () => {
    const { harness, submit, later } = await setup();
    await submit('2026-11-01', '2026-11-25');
    const stale = await prepareFinancePackage(harness.as(master), '2026-11', [SIPHO]);
    later(60);
    await submit('2026-11-01', '2026-11-25', true);
    await refusedWith(sendFinancePackage(harness.as(master), stale.id), 'package_out_of_date');
  });

  it('after a sent package, a later submission is "further submission since sending" — never "sent" for what Finance has not had (REPEAT-DATES-1: only it goes)', async () => {
    const { harness, submit, later, row } = await setup();
    await submit('2026-11-01', '2026-11-10');
    const first = await prepareFinancePackage(harness.as(master), '2026-11', [SIPHO]);
    await sendFinancePackage(harness.as(master), first.id);
    expect((await row()).status).toBe('sent');
    later(60);
    await submit('2026-11-11', '2026-11-25');
    const after = await row();
    expect(after.status).toBe('added_after_sent');
    expect(after.selectable).toBe(true);
    // Only the new submission goes, in addition — nothing of the first is sent again, nor marked CORRECTED.
    const second = await prepareFinancePackage(harness.as(master), '2026-11', [SIPHO]);
    expect(second.attachments.length).toBeGreaterThan(0);
    expect(second.attachments.every((attachment) => attachment.versionLabel.startsWith('Additional submission') && !attachment.correctedResend)).toBe(true);
    expect(second.attachments.some((attachment) => first.attachments.some((sent) => sent.sha256 === attachment.sha256))).toBe(false);
  });

  it('a package prepared and sent with nothing changed still sends (the check never blocks a current package)', async () => {
    const { harness, submit } = await setup();
    await submit('2026-11-01', '2026-11-25');
    const prepared = await prepareFinancePackage(harness.as(master), '2026-11', [SIPHO]);
    expect(prepared.attachments.every((attachment) => typeof attachment.basis === 'string' && attachment.basis.length > 0)).toBe(true);
    expect((await sendFinancePackage(harness.as(master), prepared.id)).status).toBe('sent');
  });
});

describe('F2: a calendar-month attendance submitted before PAYROLL-ONE-1 goes to Finance as submitted', () => {
  it('a day changed in the register after submission is not in the Finance PDF, and is told to the office as a register change', async () => {
    const { harness, later } = await setup();
    await recordAttendance(harness.as(sipho), { userId: SIPHO, date: '2026-10-15', status: 'present', note: '' });
    await submitMonth(harness.as(sipho), SIPHO, '2026-10', { confirmUnrecorded: true });
    later(60);
    // FORM-LIFECYCLE-1: a submitted day is locked now; a change made before this release (RESUBMIT-1) is written as it is found.
    await refusedWith(recordAttendance(harness.as(sipho), { userId: SIPHO, date: '2026-10-15', status: 'absent', absenceReason: 'leave', note: 'edited after submission' }), 'form_submitted');
    const old = (await harness.repos.attendance.findRecord(SIPHO, '2026-10-15'))!;
    await harness.repos.attendance.saveRecord({ ...old, status: 'absent', absenceReason: 'leave', note: 'edited after submission', recordedAt: clock.now() });
    const month = await loadPayrollMonth(harness.as(master), '2026-10');
    const row = month.rows.find((candidate) => candidate.technician.id === SIPHO)!;
    expect(row.attendanceChangedAfterSubmission).toBe(1);
    expect(row.detail).toContain('changed in the register after submission — Finance gets the attendance as submitted');
    expect(row.detail).not.toContain('by the office');
    const prepared = await prepareFinancePackage(harness.as(master), '2026-10', [SIPHO]);
    const attendance = prepared.attachments.find((attachment) => attachment.kind === 'attendance')!;
    expect(attendance.versionLabel).toBe('As submitted');
    const text = await pdfPlainText((await loadFinancePackageFile(harness.as(master), prepared.id, attendance.fileName)).bytes);
    expect(text).not.toContain('edited after submission');
  });
});

describe('M4: a period whose attendance changed after submission is told to the office', () => {
  it('counts the changed days on the month row; Finance still gets the stored PDF', async () => {
    const { harness, submit, later, row } = await setup();
    await recordAttendance(harness.as(sipho), { userId: SIPHO, date: '2026-11-03', status: 'present', note: '' });
    await submit('2026-11-01', '2026-11-25');
    expect((await row()).attendanceChangedAfterSubmission).toBe(0);
    later(60);
    // FORM-LIFECYCLE-1: refused through the page now; a change made before this release is written as it is found.
    await refusedWith(recordAttendance(harness.as(sipho), { userId: SIPHO, date: '2026-11-03', status: 'absent', absenceReason: 'sick_leave', note: '' }), 'form_submitted');
    const old = (await harness.repos.attendance.findRecord(SIPHO, '2026-11-03'))!;
    await harness.repos.attendance.saveRecord({ ...old, status: 'absent', absenceReason: 'sick_leave', note: '', recordedAt: clock.now() });
    const changed = await row();
    expect(changed.attendanceChangedAfterSubmission).toBe(1);
    expect(changed.detail).toContain('1 attendance day(s) changed in the register after submission');
  });
});

describe('F3: the office never writes a technician\'s timesheet comment', () => {
  it('a Master and a Coordinator are refused; the technician still can', async () => {
    const { harness } = await setup();
    await saveTimesheetLine(harness.as(sipho), SIPHO, { id: crypto.randomUUID(), date: '2026-11-03', typed: typed('1'), expectedRevision: null });
    for (const office of [master, coordinator]) {
      await refusedWith(saveTimesheetComment(harness.as(office), SIPHO, '2026-11-03', 'written by the office'), 'not_permitted');
    }
    expect((await saveTimesheetComment(harness.as(sipho), SIPHO, '2026-11-03', 'Waited for the crane'))?.comment).toBe('Waited for the crane');
  });
});

describe('F4: a name Windows keeps for itself is refused with any extension', () => {
  it.each(['CON.a', 'nul.x', 'aux.1', 'Com1.report', ' lpt9 .x'])('%s.pdf', (name) => {
    expect(normalisePdfFileName(`${name}.pdf`).ok).toBe(false);
  });
  it.each(['Console.pdf', 'Nullarbor trip.pdf', 'Auxiliary.pdf', 'COM10 notes.pdf'])('%s is an ordinary name', (name) => {
    expect(normalisePdfFileName(name).ok).toBe(true);
  });
});

describe('D1: a submitted timesheet keeps the name it was submitted under', () => {
  it('the submission\'s PDF, opened from Timesheets or by the office, is the renamed name — and the history agrees', async () => {
    const { harness, submit } = await setup();
    await saveTimesheetLine(harness.as(sipho), SIPHO, { id: crypto.randomUUID(), date: '2026-11-03', typed: typed('2'), expectedRevision: null });
    await renamePayrollDocument(harness.as(sipho), SIPHO, 'timesheet', 'Jan Nov sheet');
    const submission = await submit('2026-11-01', '2026-11-25');
    const periodId = (await harness.repos.payroll.findPayrollSubmission(submission.id))!.timesheetPeriodId!;
    for (const who of [sipho, master]) {
      expect((await loadSubmissionDocument(harness.as(who), periodId)).fileName).toBe('Jan Nov sheet.pdf');
      expect((await loadSubmissionDocument(harness.as(who), periodId, 'original')).fileName).toBe('Jan Nov sheet.pdf');
    }
    expect((await listPayrollHistory(harness.as(sipho), SIPHO))[0]?.fileNames.timesheet).toBe('Jan Nov sheet.pdf');
  });
});
