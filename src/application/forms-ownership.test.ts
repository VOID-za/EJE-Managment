import { beforeEach, describe, expect, it } from 'vitest';
import { type TimesheetLineTyped, type User } from '@/domain';
import { recordAttendance } from './attendance-operations';
import { loadPayrollMonth } from './finance-packages';
import { completePayrollForm, loadCompletedFormPdf, loadMyCompletedForms, submitCompletedForms } from './payroll-completions';
import { listPayrollHistory, loadPayrollForms, loadSubmittedPayrollDocument } from './payroll-forms';
import { saveTimesheetLine } from './timesheet-lines';
import { listTimesheetSubmissions, loadWorkingTimesheet } from './timesheets';
import { buildHarness, seedUser, type Harness } from './test-harness';

/**
 * MY MONTHLY FORMS IS PERSONAL — FORMS-OWN-1, HISTORY-ONE-1 and REPEAT-DATES-1 (the owner, 7 November 2026).
 *
 * Every role reads ONLY its own completed forms, corrections and history, by the session's identity — never an id
 * in the request; the Office and a Senior Tech review everybody's SUBMISSIONS in the management area (EJE Monthly
 * Forms), never on a personal page. The Office (Coordinator) keeps attendance only: no timesheet is completed,
 * submitted, shown in its history or downloaded as its own. And somebody else's submissions never touch the dates
 * a person may choose.
 */
const sipho = seedUser('user-tech-sipho');
const riaan = seedUser('user-tech-riaan');
const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');
const apprentice: User = { ...seedUser('user-tech-thabo'), role: 'apprentice' };
const clock = { at: '2026-11-26T06:00:00.000Z', now(): string { return this.at; } };
const FROM = '2026-11-01';
const TO = '2026-11-25';

let harness: Harness;
beforeEach(async () => {
  clock.at = '2026-11-26T06:00:00.000Z';
  harness = buildHarness({ clock });
  await harness.repos.users.save(apprentice);
});

const typed = (overtime: string, customerName = 'ABC Engineering'): TimesheetLineTyped => ({
  pick: '', customerName, overtime, double: '0', callout: '0', internalKm: '0', customerKm: '0',
});
const refusedWith = async (work: Promise<unknown>, code: string) => expect(work).rejects.toMatchObject({ violations: [{ code }] });
const line = (who: User, date: string, customerName = 'ABC Engineering') =>
  saveTimesheetLine(harness.as(who), who.id, { id: crypto.randomUUID(), date, typed: typed('1', customerName), expectedRevision: null });
const complete = (who: User, kind: 'timesheet' | 'attendance', from = FROM, to = TO) =>
  completePayrollForm(harness.as(who), who.id, { kind, from, to, fileName: '', confirmUnrecorded: true, confirmNoLines: true });
/** Completes and submits the person's forms for the dates: both, or attendance alone for the Office. */
const submitAll = async (who: User, keepsTimesheet: boolean, from = FROM, to = TO) => {
  await recordAttendance(harness.as(who), { userId: who.id, date: from, status: 'present', note: '' }).catch(() => undefined);
  if (keepsTimesheet) await complete(who, 'timesheet', from, to);
  await complete(who, 'attendance', from, to);
  return submitCompletedForms(harness.as(who), who.id);
};

describe('FORMS-OWN-1 — each role reads only its own forms; the office reviews submissions in the management area', () => {
  const people = [
    { name: 'Senior Tech', user: master, keeps: true },
    { name: 'Technician', user: sipho, keeps: true },
    { name: 'Apprentice', user: apprentice, keeps: true },
    { name: 'Office (Coordinator)', user: coordinator, keeps: false },
  ] as const;

  for (const { name, user, keeps } of people) {
    it(`${name}: completes, submits and reads their own; nobody else's — and nobody reads theirs`, async () => {
      if (keeps) await line(user, '2026-11-05');
      const submission = await submitAll(user, keeps);
      expect(submission.timesheetRequired).toBe(keeps);
      // Their own: completed forms, history (one row, newest first), and the PDFs as they went.
      await expect(loadMyCompletedForms(harness.as(user), user.id)).resolves.toMatchObject({ timesheet: null, attendance: null });
      const history = await listPayrollHistory(harness.as(user), user.id);
      expect(history.map((entry) => entry.id)).toEqual([submission.id]);
      expect(history[0]!.documents.map((document) => document.kind)).toEqual(keeps ? ['timesheet', 'attendance'] : ['attendance']);
      await expect(loadSubmittedPayrollDocument(harness.as(user), submission.id, 'attendance')).resolves.toMatchObject({ pageCount: 1 });
      // Anybody else — whatever their role — is refused this person's personal forms.
      for (const other of [sipho, riaan, master, coordinator, apprentice].filter((candidate) => candidate.id !== user.id)) {
        await refusedWith(loadMyCompletedForms(harness.as(other), user.id), 'not_permitted');
        await refusedWith(listPayrollHistory(harness.as(other), user.id), 'not_permitted');
      }
    });
  }

  it('a completed form awaiting submission is read by its owner only — a Senior Tech and the Office included', async () => {
    const form = await complete(sipho, 'attendance');
    await expect(loadCompletedFormPdf(harness.as(sipho), form.id)).resolves.toMatchObject({ fileName: form.fileName });
    for (const other of [riaan, master, coordinator, apprentice]) await refusedWith(loadCompletedFormPdf(harness.as(other), form.id), 'form_not_found');
  });

  it('the management area: the Office and a Senior Tech read every submission; a Technician and an Apprentice are refused', async () => {
    await line(sipho, '2026-11-05');
    const submission = await submitAll(sipho, true);
    for (const office of [master, coordinator]) {
      const month = await loadPayrollMonth(harness.as(office), '2026-11');
      expect(month.rows.find((row) => row.technician.id === sipho.id)?.submissions.map((entry) => entry.id)).toEqual([submission.id]);
      await expect(loadSubmittedPayrollDocument(harness.as(office), submission.id, 'timesheet')).resolves.toBeDefined();
      expect((await listTimesheetSubmissions(harness.as(office))).map((entry) => entry.id)).toContain(submission.timesheetPeriodId);
    }
    for (const field of [riaan, apprentice]) {
      await refusedWith(loadPayrollMonth(harness.as(field), '2026-11'), 'not_permitted');
      await refusedWith(loadSubmittedPayrollDocument(harness.as(field), submission.id, 'attendance'), 'submission_not_found');
    }
  });
});

describe('the Office keeps attendance only — refused on the server, not only hidden', () => {
  it('cannot write, complete or submit a timesheet, nor read a timesheet of its own history', async () => {
    await refusedWith(line(coordinator, '2026-11-05'), 'timesheet_not_required');
    await refusedWith(complete(coordinator, 'timesheet'), 'timesheet_not_required');
    const submission = await submitAll(coordinator, false);
    expect(submission.documents.map((document) => document.kind)).toEqual(['attendance']);
    await refusedWith(loadSubmittedPayrollDocument(harness.as(coordinator), submission.id, 'timesheet'), 'document_not_found');
    expect((await listPayrollHistory(harness.as(coordinator), coordinator.id)).flatMap((entry) => entry.documents.map((document) => document.kind))).toEqual(['attendance']);
    // Attendance alone has no work lines: the same days submitted again would only reach Finance twice — refused.
    await refusedWith(complete(coordinator, 'attendance'), 'attendance_already_submitted');
    await refusedWith(complete(coordinator, 'attendance', '2026-11-20', '2026-11-30'), 'attendance_already_submitted');
    await expect(complete(coordinator, 'attendance', '2026-11-26', '2026-11-30')).resolves.toMatchObject({ kind: 'attendance' });
  });
});

describe('REPEAT-DATES-1 — another person’s submissions never touch the dates a person may choose', () => {
  it('Riaan submitted 1–25 November; Sipho’s same dates show no repeat and no lock, and Sipho submits them', async () => {
    await line(riaan, '2026-11-05', 'RIAAN-LINE');
    await submitAll(riaan, true);
    await line(sipho, '2026-11-05', 'SIPHO-LINE');
    const state = await loadPayrollForms(harness.as(sipho), sipho.id, FROM, TO);
    expect(state.repeats).toEqual([]);
    expect(state.problems).toEqual([]);
    const own = await submitAll(sipho, true);
    const period = await harness.repos.attendance.findPeriodById(own.timesheetPeriodId!);
    expect(period?.snapshot?.entries.map((entry) => entry.customerName)).toEqual(['SIPHO-LINE']);
    // Nor does a withdrawn form or a correction draft of Riaan's — or Sipho's own working sheet — lock anything.
    expect((await loadWorkingTimesheet(harness.as(sipho), sipho.id)).entries).toEqual([]);
  });
});
