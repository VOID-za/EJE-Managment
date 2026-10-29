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

/** A technician fills in and submits the month. */
const submitFor = async (user: User) => {
  await saveTimesheetEntry(harness.as(user), user.id, line(`${MONTH}-03`));
  await recordAttendance(harness.as(user), { userId: user.id, date: `${MONTH}-07`, status: 'absent', absenceReason: 'sick_leave', note: 'Clinic' });
  return submitMonth(harness.as(user), user.id, MONTH, { confirmUnrecorded: true });
};

describe('PAY-03 — file names', () => {
  it('follow the owner’s examples exactly, from the technician’s name on documents and the month', () => {
    expect(timesheetMonthFileName('JC', '2026-10')).toBe('JC TIMESHEET OCT.pdf');
    expect(attendanceMonthFileName('JC', '2026-10')).toBe('JC ATTEN OCTOBER.pdf');
    expect(timesheetMonthFileName('Ruan', '2026-10')).toBe('RUAN TIMESHEET OCT.pdf');
    expect(attendanceMonthFileName('ruan', '2026-10')).toBe('RUAN ATTEN OCTOBER.pdf');
    expect(timesheetMonthFileName('JC', '2026-11')).toBe('JC TIMESHEET NOV.pdf');
    expect(attendanceMonthFileName('JC', '2026-11')).toBe('JC ATTEN NOVEMBER.pdf');
  });
  it('are deterministic and file-system safe; nothing is hard-coded', () => {
    expect(sanitiseDocumentName('  j/c*: "x" ')).toBe('J C X');
    expect(timesheetMonthFileName('a<b>|c?', '2026-02')).toBe('A B C TIMESHEET FEB.pdf');
    expect(documentNameOf({ firstName: 'Ruan', initials: 'RB', documentName: null })).toBe('RUAN');
    expect(documentNameOf({ firstName: 'Johannes', initials: 'JC', documentName: 'JC' })).toBe('JC');
    expect(documentNameOf({ firstName: '', initials: '', documentName: '' })).toBe('TECHNICIAN');
    expect(correctedFileName('JC TIMESHEET OCT.pdf')).toBe('JC TIMESHEET OCT CORRECTED.pdf');
    expect(timesheetPeriodFileName('JC', '2026-10-01', '2026-10-31')).toBe('JC TIMESHEET OCT.pdf');
    expect(timesheetPeriodFileName('JC', '2026-10-03', '2026-10-12')).toBe('JC TIMESHEET 3 OCT-12 OCT.pdf');
    expect(timesheetPeriodFileName('JC', '2026-12-28', '2027-01-03')).toBe('JC TIMESHEET 28 DEC-3 JAN 2027.pdf');
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
  it('is the actual attendance document, one PDF page, every day of the month, reasons included', async () => {
    await recordAttendance(harness.as(sipho), { userId: SIPHO, date: `${MONTH}-07`, status: 'absent', absenceReason: 'iod', note: 'Hand injury' });
    await recordAttendance(harness.as(sipho), { userId: SIPHO, date: `${MONTH}-08`, status: 'present', note: '' });
    const doc = await loadAttendanceDocument(harness.as(sipho), SIPHO, MONTH);
    expect(doc.rows).toHaveLength(Number(TO.slice(8, 10)));
    expect(doc.rows.find((row) => row.date === `${MONTH}-07`)).toMatchObject({ status: 'Absent', reason: 'IOD (Injury on Duty)', note: 'Hand injury' });
    expect(doc.versionLabel).toBe('Draft — not submitted');
    const rendered = renderAttendancePdf(doc, { generatedAt: '2026-10-29T08:00:00.000Z' });
    expect(rendered.pageCount).toBe(1);
    expect(pdfPageTexts(rendered.bytes)).toHaveLength(1);
    expect(pdfPageTexts(rendered.bytes)[0]).toContain('Hand injury');
  });
  it('a technician reads only their own; the office reads anybody’s', async () => {
    await expect(loadAttendanceDocument(harness.as(riaan), SIPHO, MONTH)).rejects.toMatchObject({ violations: [{ code: 'not_permitted' }] });
    await expect(loadAttendanceDocument(harness.as(coordinator), SIPHO, MONTH)).resolves.toBeDefined();
    await expect(loadAttendanceDocument(harness.as(sipho), SIPHO, '2026-13')).rejects.toMatchObject({ violations: [{ code: 'invalid_month' }] });
  });
});

describe('PAY-02 — submitting the month: timesheet and attendance together, once', () => {
  it('sends the timesheet for exactly the month and freezes the attendance; one office notification; audited', async () => {
    const submission = await submitFor(sipho);
    expect(submission.month).toBe(MONTH);
    const period = await harness.repos.attendance.findPeriod(SIPHO, FROM, TO);
    expect(period?.submittedAt).not.toBeNull();
    expect(submission.timesheetPeriodId).toBe(period!.id);
    expect(submission.attendance.days.find((day) => day.date === `${MONTH}-07`)).toMatchObject({ status: 'absent', absenceReason: 'sick_leave' });
    expect(await events('monthly_forms_submitted')).toHaveLength(1);
    const office = (await harness.repos.users.list()).filter((u) => (u.role === 'master' || u.role === 'coordinator') && u.active);
    for (const person of office) {
      const notes = (await harness.repos.notifications.list(person.id)).filter((n) => n.type === 'timesheet_submitted');
      expect(notes).toHaveLength(1);
      expect(notes[0]?.title).toMatch(/timesheet and attendance/u);
    }
  });

  it('once only: a retry is refused and nothing is duplicated', async () => {
    await submitFor(sipho);
    await expect(submitMonth(harness.as(sipho), SIPHO, MONTH, { confirmUnrecorded: true })).rejects.toMatchObject({ violations: [{ code: 'month_submitted' }] });
    expect(await harness.repos.payroll.listSubmissions(MONTH)).toHaveLength(1);
  });

  it('only the technician themselves; not another technician, not the office', async () => {
    for (const actor of [riaan, master, coordinator]) {
      await expect(submitMonth(harness.as(actor), SIPHO, MONTH, { confirmUnrecorded: true })).rejects.toMatchObject({ violations: [{ code: 'not_permitted' }] });
    }
  });

  it('refuses a month that has not ended, unconfirmed missing weekdays, and an absent day without a reason', async () => {
    const thisMonth = monthOfDate(businessToday());
    const lastDay = monthBounds(thisMonth).to;
    if (lastDay > businessToday()) {
      await expect(submitMonth(harness.as(sipho), SIPHO, thisMonth, { confirmUnrecorded: true })).rejects.toMatchObject({ violations: [{ code: 'month_not_ended' }] });
    }
    await expect(submitMonth(harness.as(sipho), SIPHO, MONTH)).rejects.toMatchObject({ violations: [{ code: 'attendance_incomplete' }] });
    await harness.repos.attendance.saveRecord({
      id: 'att-old', userId: SIPHO, date: `${MONTH}-10`, status: 'absent', absenceReason: null, note: 'from before the reasons',
      recordedBy: SIPHO, recordedAt: `${MONTH}-10T08:00:00.000Z`,
    });
    await expect(submitMonth(harness.as(sipho), SIPHO, MONTH, { confirmUnrecorded: true })).rejects.toMatchObject({ violations: [{ code: 'absence_reason_required' }] });
    expect(await harness.repos.payroll.listSubmissions(MONTH)).toHaveLength(0);
  });

  it('a month that shares days with a different sent period is refused — no day is sent twice', async () => {
    await saveTimesheetEntry(harness.as(sipho), SIPHO, line(`${MONTH}-03`));
    await submitTimesheetPeriod(harness.as(sipho), SIPHO, `${MONTH}-01`, `${MONTH}-07`);
    const forms = await loadMonthlyForms(harness.as(sipho), SIPHO, MONTH);
    expect(forms.canSubmit).toBe(false);
    expect(forms.timesheet.blockingPeriods).toHaveLength(1);
    await expect(submitMonth(harness.as(sipho), SIPHO, MONTH, { confirmUnrecorded: true })).rejects.toMatchObject({ violations: [{ code: 'period_overlaps_submitted' }] });
  });

  it('an exact month period already sent is used, not sent again', async () => {
    await saveTimesheetEntry(harness.as(sipho), SIPHO, line(`${MONTH}-03`));
    const period = await submitTimesheetPeriod(harness.as(sipho), SIPHO, FROM, TO);
    const submission = await submitMonth(harness.as(sipho), SIPHO, MONTH, { confirmUnrecorded: true });
    expect(submission.timesheetPeriodId).toBe(period.id);
  });

  it('after submission the technician cannot change that month’s attendance; the office can, and the form says so', async () => {
    await submitFor(sipho);
    await expect(
      recordAttendance(harness.as(sipho), { userId: SIPHO, date: `${MONTH}-14`, status: 'present', note: '' }),
    ).rejects.toMatchObject({ violations: [{ code: 'attendance_month_submitted' }] });
    await recordAttendance(harness.as(coordinator), { userId: SIPHO, date: `${MONTH}-14`, status: 'present', note: 'Office correction' });
    const current = await loadAttendanceDocument(harness.as(master), SIPHO, MONTH);
    expect(current.versionLabel).toMatch(/^Corrected by the office after submission \(1 day/u);
    const submitted = await loadAttendanceDocument(harness.as(master), SIPHO, MONTH, 'submitted');
    expect(submitted.rows.find((row) => row.date === `${MONTH}-14`)?.status).toBe('NOT RECORDED');
    expect(submitted.inForce).toBe(false);
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
