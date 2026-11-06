import { beforeEach, describe, expect, it } from 'vitest';
import { FINANCE_PACKAGE_MAX_BYTES, asUserId, type User } from '@/domain';
import { businessToday } from '@/lib/business-time';
import { sha256Hex } from '@/lib/job-card/document-identity';
import { pdfPageTexts } from '@/lib/pdf/inspect';
import {
  attendanceMonthFileName,
  correctedFileName,
  documentNameOf,
  monthBounds,
  monthOfDate,
  previousMonth,
  sanitiseDocumentName,
  timesheetMonthFileName,
  timesheetPeriodFileName,
  attendancePeriodFileName,
} from '@/lib/payroll-files';
import { MAX_ATTACHMENT_BYTES, UnconfiguredEmailService } from '@/services/production/email';
import type { DeliveryReceipt, EmailMessage, EmailService } from '@/services/ports';
import { renderAttendancePdf } from '@/services/simulated/attendance-pdf';
import { renderTimesheetPdf } from '@/services/simulated/timesheet-pdf';
import { recordAttendance } from './attendance-operations';
import { loadAttendanceDocument } from './attendance-document';
import {
  discardFinancePackage,
  loadFinancePackageFile,
  loadPayrollMonth,
  prepareFinancePackage,
  sendFinancePackage,
} from './finance-packages';
import { loadMonthlyForms, submitMonth } from './monthly-submissions';
import { decideTimesheetCorrection, requestTimesheetCorrection } from './timesheet-corrections';
import { loadTimesheetDocument, saveTimesheetEntry, submitTimesheetPeriod } from './timesheets';
import { buildHarness, seedUser, type Harness } from './test-harness';

/**
 * PAY-01 … PAY-08 — MONTHLY PAYROLL FORMS AND THE FINANCE PACKAGE (29 October 2026).
 * Every rule proved at the operation — the server — with synthetic people only,
 * and a FAKE mail transport: nothing here can reach a real Finance mailbox.
 */
const SIPHO = asUserId('user-tech-sipho');
const RIAAN = asUserId('user-tech-riaan');
const sipho = seedUser('user-tech-sipho');
const riaan = seedUser('user-tech-riaan');
const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');

const MONTH = previousMonth(monthOfDate(businessToday()));
const { from: FROM, to: TO } = monthBounds(MONTH);
const FINANCE = 'payroll@finance.example.test';

/** A fake mail transport that records every message it is handed. */
class RecordingEmail implements EmailService {
  readonly sent: EmailMessage[] = [];
  failNext: Error | null = null;
  async send(message: EmailMessage): Promise<DeliveryReceipt> {
    if (this.failNext !== null) {
      const failure = this.failNext;
      this.failNext = null;
      throw failure;
    }
    this.sent.push(message);
    return { messageId: `fake-${this.sent.length}`, state: 'pending_delivery', failureReason: '', entry: null };
  }
  deliveryState(): Promise<DeliveryReceipt | null> {
    return Promise.resolve(null);
  }
  readiness() {
    return { ready: true, detail: 'Fake transport for tests.' };
  }
}

let harness: Harness;
let email: RecordingEmail;
beforeEach(async () => {
  email = new RecordingEmail();
  harness = buildHarness({ email });
  const settings = await harness.repos.settings.get();
  await harness.repos.settings.save({ ...settings, financeEmail: FINANCE });
});

const line = (date: string, overrides: Record<string, unknown> = {}) => ({
  date, customerName: 'ABC Engineering', overtimeHours: 1.5, doubleHours: 0, calloutAmount: 45000, calloutShared: false, internalKm: 12.5, customerKm: 40, ...overrides,
});

const events = async (type: string) => (await harness.repos.activity.list()).filter((event) => event.type === type);

/**
 * A technician fills in and submits their month: the timesheet on payday from
 * the Timesheets page (TS-PAPER — here a period ending in the month), then the
 * monthly forms, which carry the attendance.
 */
const submitFor = async (user: User) => {
  await saveTimesheetEntry(harness.as(user), user.id, line(`${MONTH}-03`));
  await submitTimesheetPeriod(harness.as(user), user.id, FROM, TO);
  await recordAttendance(harness.as(user), { userId: user.id, date: `${MONTH}-07`, status: 'absent', absenceReason: 'sick_leave', note: 'Clinic' });
  return submitMonth(harness.as(user), user.id, MONTH, { confirmUnrecorded: true });
};

describe('PAY-03 — file names', () => {
  it('follow the owner’s examples exactly, from the technician’s name on documents and the month', () => {
    expect(timesheetMonthFileName('JC', '2026-10')).toBe('JC Timesheet Oct 2026.pdf');
    expect(attendanceMonthFileName('JC', '2026-10')).toBe('JC ATTEN OCTOBER.pdf');
    expect(timesheetMonthFileName('Ruan', '2026-10')).toBe('RUAN Timesheet Oct 2026.pdf');
    expect(attendanceMonthFileName('ruan', '2026-10')).toBe('RUAN ATTEN OCTOBER.pdf');
    expect(timesheetMonthFileName('JC', '2026-11')).toBe('JC Timesheet Nov 2026.pdf');
    expect(attendanceMonthFileName('JC', '2026-11')).toBe('JC ATTEN NOVEMBER.pdf');
  });
  it('are deterministic and file-system safe; nothing is hard-coded', () => {
    expect(sanitiseDocumentName('  j/c*: "x" ')).toBe('J C X');
    expect(timesheetMonthFileName('a<b>|c?', '2026-02')).toBe('A B C Timesheet Feb 2026.pdf');
    expect(documentNameOf({ firstName: 'Ruan', initials: 'RB', documentName: null })).toBe('RUAN');
    expect(documentNameOf({ firstName: 'Johannes', initials: 'JC', documentName: 'JC' })).toBe('JC');
    expect(documentNameOf({ firstName: '', initials: '', documentName: '' })).toBe('TECHNICIAN');
    expect(correctedFileName('JC TIMESHEET OCT.pdf')).toBe('JC TIMESHEET OCT CORRECTED.pdf');
    // TS-NAME-TO-1 (2 November 2026, superseding PDF-NAME-2): the month and year of the TO date, whatever the From.
    expect(timesheetPeriodFileName('JC', '2026-10-01', '2026-10-31')).toBe('JC Timesheet Oct 2026.pdf');
    expect(timesheetPeriodFileName('JC', '2026-10-03', '2026-10-12')).toBe('JC Timesheet Oct 2026.pdf');
    expect(timesheetPeriodFileName('JC', '2026-10-24', '2026-11-22')).toBe('JC Timesheet Nov 2026.pdf');
    expect(timesheetPeriodFileName('JC', '2026-12-28', '2027-01-03')).toBe('JC Timesheet Jan 2027.pdf');
    expect(timesheetPeriodFileName('JC', '2026-10-01', '2026-11-30')).toBe('JC Timesheet Nov 2026.pdf');
    expect(timesheetPeriodFileName('JC', '2026-10-01', '2026-12-31')).toBe('JC Timesheet Dec 2026.pdf');
    // PDF-NAME-1: the attendance period names its first and last month.
    expect(attendancePeriodFileName('JC', '2026-10-01', '2026-10-31')).toBe('JC ATTEN OCTOBER.pdf');
    expect(attendancePeriodFileName('JC', '2026-10-01', '2026-11-30')).toBe('JC Atten Oct-Nov.pdf');
    expect(attendancePeriodFileName('JC', '2026-10-15', '2026-11-14')).toBe('JC Atten Oct-Nov.pdf');
    expect(attendancePeriodFileName('JC', '2026-12-28', '2027-01-03')).toBe('JC Atten Dec 2026-Jan 2027.pdf');
    expect(attendancePeriodFileName('JC', '2026-10-03', '2026-10-20')).toBe('JC Atten 3-20 Oct.pdf');
  });
  it('the download, the document and the package use the technician’s name on documents', async () => {
    const stored = await harness.repos.users.findById(SIPHO);
    await harness.repos.users.save({ ...stored!, documentName: 'SM' });
    const timesheet = await loadTimesheetDocument(harness.as(master), SIPHO, FROM, TO);
    expect(timesheet.fileName).toBe(timesheetMonthFileName('SM', MONTH));
    const attendance = await loadAttendanceDocument(harness.as(master), SIPHO, MONTH);
    expect(attendance.fileName).toBe(attendanceMonthFileName('SM', MONTH));
  });
});

describe('PAY-01/04 — the monthly attendance form', () => {
  it('is the actual attendance document, one PDF page, its RECORDED days only, reasons included', async () => {
    await recordAttendance(harness.as(sipho), { userId: SIPHO, date: `${MONTH}-07`, status: 'absent', absenceReason: 'iod', note: 'Hand injury' });
    await recordAttendance(harness.as(sipho), { userId: SIPHO, date: `${MONTH}-08`, status: 'present', note: '' });
    const doc = await loadAttendanceDocument(harness.as(sipho), SIPHO, MONTH);
    // PDF-UNREC-1: the two recorded days, in order — no row for any other day.
    expect(doc.rows.map((row) => row.date)).toEqual([`${MONTH}-07`, `${MONTH}-08`]);
    expect(doc.rows.find((row) => row.date === `${MONTH}-07`)).toMatchObject({ status: 'Absent', reason: 'IOD (Injury on Duty)' });
    expect(doc.summary).toMatchObject({ present: 1, absent: 1 });
    expect(doc.versionLabel).toBe('Draft — not submitted');
    const rendered = renderAttendancePdf(doc, { generatedAt: '2026-10-29T08:00:00.000Z' });
    expect(rendered.pageCount).toBe(1);
    expect(pdfPageTexts(rendered.bytes)).toHaveLength(1);
    const text = pdfPageTexts(rendered.bytes)[0]!;
    // PDF-NOTES-OFF-1 (2 November 2026): no Notes column on the attendance PDF.
    expect(text).not.toContain('Hand injury');
    expect(text).not.toMatch(/\bNote\b/u);
    expect(text).toContain('IOD (Injury on Duty)');
    expect(text).toContain('Present 1 · Absent 1');
    expect(text).not.toContain('NOT RECORDED');
    expect(text).not.toMatch(/Not recorded \d/u);
    expect(text).toContain('Only recorded days are listed');
  });
  it('a technician reads only their own; the office reads anybody’s', async () => {
    await expect(loadAttendanceDocument(harness.as(riaan), SIPHO, MONTH)).rejects.toMatchObject({ violations: [{ code: 'not_permitted' }] });
    await expect(loadAttendanceDocument(harness.as(coordinator), SIPHO, MONTH)).resolves.toBeDefined();
    await expect(loadAttendanceDocument(harness.as(sipho), SIPHO, '2026-13')).rejects.toMatchObject({ violations: [{ code: 'invalid_month' }] });
  });
});

describe('PAY-02 — submitting the month: timesheet and attendance together, once', () => {
  it('freezes the attendance and carries NO timesheet (TS-PAPER: timesheets are submitted by payday); one office notification; audited', async () => {
    const submission = await submitFor(sipho);
    expect(submission.month).toBe(MONTH);
    expect(submission.timesheetPeriodId).toBeNull();
    expect(submission.attendance.days.find((day) => day.date === `${MONTH}-07`)).toMatchObject({ status: 'absent', absenceReason: 'sick_leave' });
    expect(await events('monthly_forms_submitted')).toHaveLength(1);
    const office = (await harness.repos.users.list()).filter((u) => (u.role === 'master' || u.role === 'coordinator') && u.active);
    for (const person of office) {
      const notes = (await harness.repos.notifications.list(person.id)).filter((n) => n.type === 'timesheet_submitted' && /attendance/u.test(n.title));
      expect(notes).toHaveLength(1);
    }
  });

  it('PAYROLL-ONE-1: a month submitted is kept exactly as it was — never rewritten in place (RESUBMIT-1 retired)', async () => {
    const first = await submitFor(sipho);
    await expect(submitMonth(harness.as(sipho), SIPHO, MONTH, { confirmUnrecorded: true })).rejects.toMatchObject({ violations: [{ code: 'month_submitted' }] });
    expect(await harness.repos.payroll.listSubmissions(MONTH)).toEqual([first]);
  });

  it('only the technician themselves; not another technician, not the office', async () => {
    for (const actor of [riaan, master, coordinator]) {
      await expect(submitMonth(harness.as(actor), SIPHO, MONTH, { confirmUnrecorded: true })).rejects.toMatchObject({ violations: [{ code: 'not_permitted' }] });
    }
  });

  it('MONTH-END-OFF-1: a month not yet ended may be submitted; unconfirmed missing weekdays and an absent day without a reason are refused', async () => {
    const thisMonth = monthOfDate(businessToday());
    expect(monthBounds(thisMonth).to >= businessToday()).toBe(true);
    // 2 November 2026: no month-end restriction, for any role.
    expect((await loadMonthlyForms(harness.as(sipho), SIPHO, thisMonth)).problems.join(' ')).not.toMatch(/has not ended/u);
    expect(await submitMonth(harness.as(sipho), SIPHO, thisMonth, { confirmUnrecorded: true })).toMatchObject({ month: thisMonth });
    await expect(submitMonth(harness.as(sipho), SIPHO, MONTH)).rejects.toMatchObject({ violations: [{ code: 'attendance_incomplete' }] });
    await harness.repos.attendance.saveRecord({
      id: 'att-old', userId: SIPHO, date: `${MONTH}-10`, status: 'absent', absenceReason: null, note: 'from before the reasons',
      recordedBy: SIPHO, recordedAt: `${MONTH}-10T08:00:00.000Z`,
    });
    await expect(submitMonth(harness.as(sipho), SIPHO, MONTH, { confirmUnrecorded: true })).rejects.toMatchObject({ violations: [{ code: 'absence_reason_required' }] });
    expect(await harness.repos.payroll.listSubmissions(MONTH)).toHaveLength(0);
  });

  it('TS-PAPER: the month never sends, takes over or replaces a timesheet — a payday submission stays exactly as it is', async () => {
    await saveTimesheetEntry(harness.as(sipho), SIPHO, line(`${MONTH}-03`));
    const payday = await submitTimesheetPeriod(harness.as(sipho), SIPHO, `${MONTH}-01`, `${MONTH}-07`);
    const forms = await loadMonthlyForms(harness.as(sipho), SIPHO, MONTH);
    expect(forms.timesheetRequired).toBe(false);
    expect(forms.timesheet.versionInForce).toMatch(/Timesheets page by payday/u);
    const submission = await submitMonth(harness.as(sipho), SIPHO, MONTH, { confirmUnrecorded: true });
    expect(submission.timesheetPeriodId).toBeNull();
    const current = await harness.repos.attendance.listSubmittedPeriods(SIPHO, FROM, TO);
    expect(current.map((period) => period.id)).toEqual([payday.id]);
    expect((await harness.repos.attendance.findPeriod(SIPHO, `${MONTH}-01`, `${MONTH}-07`))?.supersededAt ?? null).toBeNull();
    // No calendar-month period was created.
    expect(await harness.repos.attendance.findPeriod(SIPHO, FROM, TO)).toBeNull();
    expect((await harness.repos.attendance.listEntries(SIPHO, FROM, TO)).map((entry) => entry.date)).toEqual([`${MONTH}-03`]);
  });

  it('after submission the days are LOCKED — for the person too (FORM-LIFECYCLE-1, replacing RESUBMIT-1); the office still may not (ATT-OWN-1)', async () => {
    await submitFor(sipho);
    const before = await harness.repos.attendance.listRecords(FROM, TO, SIPHO);
    await expect(recordAttendance(harness.as(sipho), { userId: SIPHO, date: `${MONTH}-14`, status: 'present', note: '' })).rejects.toMatchObject({
      violations: [{ code: 'form_submitted' }],
    });
    for (const office of [coordinator, master]) {
      await expect(
        recordAttendance(harness.as(office), { userId: SIPHO, date: `${MONTH}-14`, status: 'present', note: 'Office correction' }),
      ).rejects.toMatchObject({ violations: [{ code: 'not_permitted' }] });
    }
    // Until it is submitted again, the office's copy is the one submitted.
    expect((await loadAttendanceDocument(harness.as(master), SIPHO, MONTH, 'submitted')).rows.map((row) => row.date)).toEqual([`${MONTH}-07`]);
    // PAYROLL-ONE-1: never rewritten — a replacement is a payroll submission for the period, the month kept.
    await expect(submitMonth(harness.as(sipho), SIPHO, MONTH, { confirmUnrecorded: true })).rejects.toMatchObject({ violations: [{ code: 'month_submitted' }] });
    expect((await loadAttendanceDocument(harness.as(master), SIPHO, MONTH, 'submitted')).rows.map((row) => row.date)).toEqual([`${MONTH}-07`]);
    expect(await harness.repos.payroll.listSubmissions(MONTH)).toHaveLength(1);
    // The underlying attendance records are exactly as they were.
    expect(await harness.repos.attendance.listRecords(FROM, TO, SIPHO)).toEqual(before);
  });
});

/*
 * TS-ROLE-1 (the tester, 1 November 2026): a Coordinator works no overtime and
 * keeps no timesheet — only attendance. A Master keeps both, like a technician.
 */
describe('TS-ROLE-1 — a Coordinator’s month is attendance only', () => {
  const COORD = coordinator.id;

  it('a Coordinator submits their attendance alone; no timesheet period is created or needed', async () => {
    await recordAttendance(harness.as(coordinator), { userId: COORD, date: `${MONTH}-07`, status: 'present', note: '' });
    const forms = await loadMonthlyForms(harness.as(coordinator), COORD, MONTH);
    expect(forms.timesheetRequired).toBe(false);
    expect(forms.timesheet.versionInForce).toMatch(/^Not required/u);
    const submission = await submitMonth(harness.as(coordinator), COORD, MONTH, { confirmUnrecorded: true });
    expect(submission.timesheetPeriodId).toBeNull();
    expect(await harness.repos.attendance.findPeriod(COORD, FROM, TO)).toBeNull();
    const [notice] = (await harness.repos.notifications.list(master.id)).filter((n) => n.type === 'timesheet_submitted');
    expect(notice?.title).toMatch(/: attendance$/u);
    // FORM-LIFECYCLE-1: her submitted days are locked; the month as submitted is kept (PAYROLL-ONE-1: never rewritten).
    await expect(recordAttendance(harness.as(coordinator), { userId: COORD, date: `${MONTH}-08`, status: 'present', note: '' })).rejects.toMatchObject({
      violations: [{ code: 'form_submitted' }],
    });
    await expect(submitMonth(harness.as(coordinator), COORD, MONTH, { confirmUnrecorded: true })).rejects.toMatchObject({ violations: [{ code: 'month_submitted' }] });
    expect((await harness.repos.payroll.findSubmission(COORD, MONTH))?.id).toBe(submission.id);
  });

  it('a Coordinator cannot enter, open, send or correct a timesheet of their own', async () => {
    const refusedWith = async (work: Promise<unknown>) =>
      expect(work).rejects.toMatchObject({ violations: [{ code: 'timesheet_not_required' }] });
    await refusedWith(saveTimesheetEntry(harness.as(coordinator), COORD, line(`${MONTH}-03`)));
    await refusedWith(loadTimesheetDocument(harness.as(coordinator), COORD, FROM, TO));
    await refusedWith(submitTimesheetPeriod(harness.as(coordinator), COORD, FROM, TO));
    await refusedWith(
      requestTimesheetCorrection(harness.as(coordinator), COORD, { from: FROM, to: TO, reason: 'x', comment: '', lines: [] }),
    );
    expect(await harness.repos.attendance.listEntries(COORD, FROM, TO)).toHaveLength(0);
    // Still the office: reads a technician's sheet.
    await expect(loadTimesheetDocument(harness.as(coordinator), SIPHO, FROM, TO)).resolves.toBeDefined();
  });

  it('a Master keeps a timesheet like a technician: submitted by payday, printed in the month it ends (TS-PAPER)', async () => {
    const submission = await submitFor(master);
    expect(submission.timesheetPeriodId).toBeNull();
    const view = await loadPayrollMonth(harness.as(coordinator), MONTH);
    expect(view.rows.find((row) => row.technician.id === master.id)?.timesheetVersion).toMatch(/^Timesheet submitted: /u);
  });

  it('the Finance package carries one PDF — the attendance — for a Coordinator, and two for the others', async () => {
    await recordAttendance(harness.as(coordinator), { userId: COORD, date: `${MONTH}-07`, status: 'present', note: '' });
    await submitMonth(harness.as(coordinator), COORD, MONTH, { confirmUnrecorded: true });
    await submitFor(sipho);
    const view = await loadPayrollMonth(harness.as(master), MONTH);
    expect(view.rows.find((row) => row.technician.id === COORD)).toMatchObject({ status: 'ready', timesheetRequired: false });
    // TS-PAPER: nobody's month carries a timesheet now; Sipho's payday submission ending in it is printed.
    expect(view.rows.find((row) => row.technician.id === SIPHO)).toMatchObject({ timesheetRequired: false, timesheetVersion: expect.stringMatching(/^Timesheet submitted: /u) as unknown });
    const alone = await prepareFinancePackage(harness.as(master), MONTH, [COORD]);
    expect(alone.attachments.map((attachment) => attachment.kind)).toEqual(['attendance']);
    await discardFinancePackage(harness.as(master), alone.id);
    const both = await prepareFinancePackage(harness.as(master), MONTH, [COORD, SIPHO]);
    expect(both.attachments.map((attachment) => `${attachment.technicianId}:${attachment.kind}`)).toEqual([
      `${COORD}:attendance`, `${SIPHO}:timesheet`, `${SIPHO}:attendance`,
    ]);
  });
});

describe('PAY-05…08 — the Finance package: both PDFs per selected technician, ONE email', () => {
  it('the office sees every technician’s status; a technician cannot', async () => {
    await submitFor(sipho);
    const view = await loadPayrollMonth(harness.as(coordinator), MONTH);
    expect(view.recipient).toBe(FINANCE);
    expect(view.rows.find((row) => row.technician.id === SIPHO)).toMatchObject({ status: 'ready', selectable: true });
    expect(view.rows.find((row) => row.technician.id === RIAAN)).toMatchObject({ status: 'not_submitted', selectable: false });
    await expect(loadPayrollMonth(harness.as(sipho), MONTH)).rejects.toMatchObject({ violations: [{ code: 'not_permitted' }] });
    await expect(prepareFinancePackage(harness.as(sipho), MONTH, [SIPHO])).rejects.toMatchObject({ violations: [{ code: 'not_permitted' }] });
  });

  it('prepares a manifest of exactly two one-page PDFs per technician, stored write-once, named by the rule', async () => {
    await submitFor(sipho);
    await submitFor(riaan);
    const prepared = await prepareFinancePackage(harness.as(coordinator), MONTH, [SIPHO, RIAAN]);
    expect(prepared.status).toBe('prepared');
    expect(prepared.attachments).toHaveLength(4);
    const names = prepared.attachments.map((attachment) => attachment.fileName).sort();
    expect(names).toEqual([
      attendanceMonthFileName('RIAAN', MONTH), attendanceMonthFileName('SIPHO', MONTH),
      timesheetMonthFileName('RIAAN', MONTH), timesheetMonthFileName('SIPHO', MONTH),
    ].sort());
    for (const attachment of prepared.attachments) {
      expect(attachment.pageCount).toBe(1);
      // The production file store accepts only these characters in a key.
      expect(attachment.storageKey).toMatch(/^[A-Za-z0-9/._-]+$/u);
      expect(attachment.storageKey).not.toContain('..');
      const stored = await harness.services.storage.getDocument(attachment.storageKey);
      expect(stored?.bytes.byteLength).toBe(attachment.sizeBytes);
      expect(await sha256Hex(stored!.bytes)).toBe(attachment.sha256);
      expect(pdfPageTexts(stored!.bytes)).toHaveLength(1);
    }
    expect(prepared.totalBytes).toBe(prepared.attachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0));
    expect(email.sent).toHaveLength(0);
    expect(await events('finance_package_prepared')).toHaveLength(1);
  });

  it('the package PDFs are the same documents the technician previews and downloads', async () => {
    await submitFor(sipho);
    const prepared = await prepareFinancePackage(harness.as(master), MONTH, [SIPHO]);
    const timesheet = prepared.attachments.find((attachment) => attachment.kind === 'timesheet')!;
    const stored = await harness.services.storage.getDocument(timesheet.storageKey);
    const own = renderTimesheetPdf(await loadTimesheetDocument(harness.as(sipho), SIPHO, FROM, TO), { generatedAt: '2026-10-29T08:00:00.000Z' });
    const strip = (text: string) => text.replace(/Generated .*/u, '');
    expect(strip(pdfPageTexts(stored!.bytes)[0]!)).toBe(strip(pdfPageTexts(own.bytes)[0]!));
  });

  it('refuses what is not ready, naming the technician; never prepares two open packages', async () => {
    await submitFor(sipho);
    await expect(prepareFinancePackage(harness.as(master), MONTH, [RIAAN])).rejects.toMatchObject({ violations: [{ code: 'payroll_not_submitted' }] });
    await expect(prepareFinancePackage(harness.as(master), MONTH, [SIPHO, SIPHO])).rejects.toMatchObject({ violations: [{ code: 'duplicate_technician' }] });
    await prepareFinancePackage(harness.as(master), MONTH, [SIPHO]);
    await expect(prepareFinancePackage(harness.as(master), MONTH, [SIPHO])).rejects.toMatchObject({ violations: [{ code: 'package_open' }] });
  });

  it('refuses with no Finance recipient configured', async () => {
    await submitFor(sipho);
    const settings = await harness.repos.settings.get();
    await harness.repos.settings.save({ ...settings, financeEmail: '' });
    await expect(prepareFinancePackage(harness.as(master), MONTH, [SIPHO])).rejects.toMatchObject({ violations: [{ code: 'finance_recipient_missing' }] });
  });

  it('a technician with a correction waiting cannot be included until the office decides it', async () => {
    await submitFor(sipho);
    const sheet = await loadTimesheetDocument(harness.as(sipho), SIPHO, FROM, TO);
    expect(sheet.rows.length).toBeGreaterThan(0);
    const period = await harness.repos.attendance.findPeriod(SIPHO, FROM, TO);
    const entry = period!.snapshot!.entries[0]!;
    await requestTimesheetCorrection(harness.as(sipho), SIPHO, {
      from: FROM, to: TO, reason: 'OT was 3', comment: '',
      lines: [{ ...line(entry.date, { overtimeHours: 3 }), entryId: entry.id }],
    });
    await expect(prepareFinancePackage(harness.as(master), MONTH, [SIPHO])).rejects.toMatchObject({ violations: [{ code: 'payroll_correction_pending' }] });
  });

  it('SENDS ONE EMAIL with every attachment, records the provider’s answer, and never sends twice', async () => {
    await submitFor(sipho);
    await submitFor(riaan);
    const prepared = await prepareFinancePackage(harness.as(coordinator), MONTH, [SIPHO, RIAAN]);
    const sent = await sendFinancePackage(harness.as(coordinator), prepared.id);
    expect(sent.status).toBe('sent');
    expect(sent.providerMessageId).toBe('fake-1');
    expect(sent.providerState).toBe('pending_delivery');
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.to).toEqual([FINANCE]);
    expect(email.sent[0]?.attachments?.map((attachment) => attachment.fileName).sort()).toEqual(prepared.attachments.map((attachment) => attachment.fileName).sort());
    expect(email.sent[0]?.subject).toMatch(/2 technicians/u);
    await expect(sendFinancePackage(harness.as(master), prepared.id)).rejects.toMatchObject({ violations: [{ code: 'package_sent' }] });
    expect(email.sent).toHaveLength(1);
    const audits = await events('finance_package_sent');
    expect(audits).toHaveLength(1);
    expect(audits[0]?.detail).toContain(prepared.id);
    expect(audits[0]?.detail).toContain(timesheetMonthFileName('SIPHO', MONTH));
    // Sent: that technician is no longer selectable, and the files read back exactly.
    const view = await loadPayrollMonth(harness.as(master), MONTH);
    expect(view.rows.find((row) => row.technician.id === SIPHO)).toMatchObject({ status: 'sent', selectable: false });
    const file = await loadFinancePackageFile(harness.as(master), prepared.id, timesheetMonthFileName('SIPHO', MONTH));
    expect(await sha256Hex(file.bytes)).toBe(prepared.attachments.find((attachment) => attachment.fileName === file.fileName)!.sha256);
    await expect(loadFinancePackageFile(harness.as(sipho), prepared.id, file.fileName)).rejects.toMatchObject({ violations: [{ code: 'not_permitted' }] });
  });

  it('two clicks at once produce exactly one email', async () => {
    await submitFor(sipho);
    const prepared = await prepareFinancePackage(harness.as(master), MONTH, [SIPHO]);
    const results = await Promise.allSettled([
      sendFinancePackage(harness.as(master), prepared.id),
      sendFinancePackage(harness.as(coordinator), prepared.id),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(email.sent).toHaveLength(1);
  });

  it('a provider failure is recorded as failed — never as sent — and may be sent again', async () => {
    await submitFor(sipho);
    const prepared = await prepareFinancePackage(harness.as(master), MONTH, [SIPHO]);
    email.failNext = Object.assign(new Error('Microsoft 365 refused the credentials (HTTP 401).'), { kind: 'credentials_rejected' });
    const failed = await sendFinancePackage(harness.as(master), prepared.id);
    expect(failed).toMatchObject({ status: 'failed', failureKind: 'credentials_rejected', attempts: 1 });
    expect(failed.failureReason).toContain('401');
    expect(email.sent).toHaveLength(0);
    expect(await events('finance_package_failed')).toHaveLength(1);
    const retried = await sendFinancePackage(harness.as(master), prepared.id);
    expect(retried).toMatchObject({ status: 'sent', attempts: 2 });
    expect(email.sent).toHaveLength(1);
  });

  it('an unconfigured deployment refuses BEFORE claiming: nothing is recorded as sent or failed', async () => {
    const local = buildHarness({ email: new UnconfiguredEmailService() });
    const settings = await local.repos.settings.get();
    await local.repos.settings.save({ ...settings, financeEmail: FINANCE });
    harness = local;
    await submitFor(sipho);
    const prepared = await prepareFinancePackage(local.as(master), MONTH, [SIPHO]);
    await expect(sendFinancePackage(local.as(master), prepared.id)).rejects.toMatchObject({ violations: [{ code: 'email_not_configured' }] });
    expect((await local.repos.payroll.findPackage(prepared.id))?.status).toBe('prepared');
    const view = await loadPayrollMonth(local.as(master), MONTH);
    expect(view.email.ready).toBe(false);
  });

  it('a prepared package can be discarded; a sent one cannot', async () => {
    await submitFor(sipho);
    const prepared = await prepareFinancePackage(harness.as(master), MONTH, [SIPHO]);
    await discardFinancePackage(harness.as(master), prepared.id);
    const again = await prepareFinancePackage(harness.as(master), MONTH, [SIPHO]);
    await sendFinancePackage(harness.as(master), again.id);
    await expect(discardFinancePackage(harness.as(master), again.id)).rejects.toMatchObject({ violations: [{ code: 'package_not_discardable' }] });
  });

  it('a correction accepted AFTER sending never changes the sent package; the corrected forms go in a new one, marked CORRECTED', async () => {
    await submitFor(sipho);
    const first = await prepareFinancePackage(harness.as(master), MONTH, [SIPHO]);
    const sent = await sendFinancePackage(harness.as(master), first.id);
    const sentBytes = await Promise.all(sent.attachments.map(async (attachment) => sha256Hex((await harness.services.storage.getDocument(attachment.storageKey))!.bytes)));
    const period = await harness.repos.attendance.findPeriod(SIPHO, FROM, TO);
    const entry = period!.snapshot!.entries[0]!;
    const correction = await requestTimesheetCorrection(harness.as(sipho), SIPHO, {
      from: FROM, to: TO, reason: 'OT was 3', comment: '', lines: [{ ...line(entry.date, { overtimeHours: 3 }), entryId: entry.id }],
    });
    await decideTimesheetCorrection(harness.as(coordinator), SIPHO, correction.id, { decision: 'accept' });
    const view = await loadPayrollMonth(harness.as(master), MONTH);
    expect(view.rows.find((row) => row.technician.id === SIPHO)).toMatchObject({ status: 'corrected_after_sent', selectable: true });
    const second = await prepareFinancePackage(harness.as(master), MONTH, [SIPHO]);
    expect(second.attachments.map((attachment) => attachment.fileName).sort()).toEqual([
      correctedFileName(attendanceMonthFileName('SIPHO', MONTH)), correctedFileName(timesheetMonthFileName('SIPHO', MONTH)),
    ].sort());
    expect(second.attachments.every((attachment) => attachment.correctedResend)).toBe(true);
    // The first package is exactly as it was sent.
    const firstNow = await harness.repos.payroll.findPackage(first.id);
    expect(firstNow?.status).toBe('sent');
    const nowBytes = await Promise.all(firstNow!.attachments.map(async (attachment) => sha256Hex((await harness.services.storage.getDocument(attachment.storageKey))!.bytes)));
    expect(nowBytes).toEqual(sentBytes);
  });

  it('TEN technicians: twenty PDFs — ten timesheets and ten attendance forms — in ONE email', async () => {
    const people: User[] = [];
    for (let index = 0; index < 10; index += 1) {
      const person: User = {
        id: asUserId(`user-tech-pay-${index}`), firstName: `Tech${index}`, lastName: 'Synthetic', initials: `T${index}`,
        email: `tech${index}@example.test`, mobile: '', role: 'technician', jobTitle: 'Field Technician', active: true,
        createdAt: '2026-01-01T00:00:00.000Z', documentName: `T${index}`,
      };
      await harness.repos.users.save(person);
      people.push(person);
      await submitFor(person);
    }
    const prepared = await prepareFinancePackage(harness.as(coordinator), MONTH, people.map((person) => person.id));
    expect(prepared.attachments).toHaveLength(20);
    expect(prepared.attachments.filter((attachment) => attachment.kind === 'timesheet')).toHaveLength(10);
    expect(prepared.attachments.filter((attachment) => attachment.kind === 'attendance')).toHaveLength(10);
    expect(new Set(prepared.attachments.map((attachment) => attachment.fileName)).size).toBe(20);
    expect(prepared.totalBytes).toBeLessThanOrEqual(FINANCE_PACKAGE_MAX_BYTES);
    await sendFinancePackage(harness.as(coordinator), prepared.id);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.attachments).toHaveLength(20);
    for (const person of people) {
      const files = email.sent[0]!.attachments!.map((attachment) => attachment.fileName);
      expect(files).toContain(timesheetMonthFileName(person.documentName!, MONTH));
      expect(files).toContain(attendanceMonthFileName(person.documentName!, MONTH));
    }
  });

  it('two technicians with the same name on documents are refused rather than confused', async () => {
    const stored = await harness.repos.users.findById(RIAAN);
    await harness.repos.users.save({ ...stored!, documentName: 'SIPHO' });
    await submitFor(sipho);
    await submitFor(riaan);
    await expect(prepareFinancePackage(harness.as(master), MONTH, [SIPHO, RIAAN])).rejects.toMatchObject({ violations: [{ code: 'duplicate_file_name' }] });
  });

  it('the size ceiling is Microsoft 365’s own attachment limit', () => {
    expect(FINANCE_PACKAGE_MAX_BYTES).toBe(MAX_ATTACHMENT_BYTES);
  });
});
