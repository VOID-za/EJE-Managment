import { beforeEach, describe, expect, it } from 'vitest';
import { asUserId, type TimesheetPeriod } from '@/domain';
import { pdfPageTexts, pdfPlainText } from '@/lib/pdf/inspect';
import { renderTimesheetPdf } from '@/services/simulated/timesheet-pdf';
import {
  listTimesheetSubmissions,
  loadSubmissionDocument,
  loadWorkingTimesheet,
  saveTimesheetEntry,
  submitTimesheetPeriod,
} from './timesheets';
import { decideTimesheetCorrection, requestTimesheetCorrection } from './timesheet-corrections';
import { submitMonth } from './monthly-submissions';
import { discardFinancePackage, prepareFinancePackage } from './finance-packages';
import { buildHarness, seedUser, type Harness } from './test-harness';

/**
 * TS-PAPER-6…8 — THE FOLLOW-UP TO v1.1.0 (the owner, 4 November 2026).
 *
 *   7. A submission never drops a day: dates covering only PART of a current
 *      submission are refused; dates covering ALL of it replace it only when
 *      confirmed; a corrected one is not replaced; the original stays.
 *   7. Finance prints every current submission ending in the month — a legacy
 *      calendar-month timesheet too, until a covering submission replaces it —
 *      so every submitted line is printed once, none missing, none twice.
 *   8. The original snapshot is always readable; a replaced submission takes
 *      no new correction.
 *   6. A long timesheet prints on several readable pages, and Finance accepts it.
 */
const SIPHO = asUserId('user-tech-sipho');
const sipho = seedUser('user-tech-sipho');
const riaan = seedUser('user-tech-riaan');
const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');
const clock = { at: '2027-01-27T06:00:00.000Z', now(): string { return this.at; } };

let harness: Harness;
beforeEach(async () => {
  harness = buildHarness({ clock });
  const settings = await harness.repos.settings.get();
  await harness.repos.settings.save({ ...settings, financeEmail: 'payroll@finance.example.test' });
});

const add = (date: string, tag: string, overtimeHours = 1) =>
  saveTimesheetEntry(harness.as(sipho), SIPHO, { date, customerName: tag, overtimeHours, doubleHours: 0 });
const submit = (from: string, to: string, replace = false) => submitTimesheetPeriod(harness.as(sipho), SIPHO, from, to, { replace });
const tagsOf = async (id: string, version: 'current' | 'original' = 'current') =>
  (await loadSubmissionDocument(harness.as(master), id, version)).rows.map((row) => row.customer).sort();
/** Everything stored about Sipho's timesheets, to prove a refusal changed nothing. */
const state = async () => ({
  periods: (await harness.repos.attendance.listSubmissions(SIPHO)).map((period: TimesheetPeriod) => [period.id, period.from, period.to, period.supersededAt ?? null, period.snapshot]),
  entries: await harness.repos.attendance.listEntries(SIPHO, '2000-01-01', '2099-12-31'),
  audit: (await harness.repos.activity.list()).length,
});
/** The month's Finance package: the attendance submitted, prepared, every timesheet attachment read, then discarded. */
const packageOf = async (month: string) => {
  await submitMonth(harness.as(sipho), SIPHO, month, { confirmUnrecorded: true });
  const prepared = await prepareFinancePackage(harness.as(master), month, [SIPHO]);
  const sheets: { file: string; pages: number; tags: string[] }[] = [];
  for (const attachment of prepared.attachments.filter((item) => item.kind === 'timesheet')) {
    const stored = await harness.services.storage.getDocument(attachment.storageKey);
    sheets.push({ file: attachment.fileName, pages: attachment.pageCount, tags: (pdfPlainText(stored!.bytes).match(/L-\d{4}/gu) ?? []).sort() });
  }
  const attendancePages = prepared.attachments.filter((item) => item.kind === 'attendance').map((item) => item.pageCount);
  await discardFinancePackage(harness.as(master), prepared.id);
  return { sheets, attendancePages, tags: sheets.flatMap((sheet) => sheet.tags).sort() };
};

describe('TS-PAPER-7 — a submission never drops a day', () => {
  it('the owner’s example: 1–25 Nov submitted, then 20 Nov–15 Dec is REFUSED and nothing changes', async () => {
    await add('2026-11-05', 'L-1105');
    await add('2026-11-22', 'L-1122');
    await add('2026-12-10', 'L-1210');
    const existing = await submit('2026-11-01', '2026-11-25');
    const before = await state();
    for (const replace of [false, true]) {
      await expect(submit('2026-11-20', '2026-12-15', replace)).rejects.toMatchObject({
        message: expect.stringContaining('Sun 1 Nov 2026 – Wed 25 Nov 2026') as unknown,
        violations: [{ code: 'timesheet_partial_overlap' }],
      });
    }
    expect(await state()).toEqual(before);
    expect(await tagsOf(existing.id)).toEqual(['L-1105', 'L-1122']);
    // The way forward still works: start after it ends.
    const next = await submit('2026-11-26', '2026-12-15');
    expect(await tagsOf(next.id)).toEqual(['L-1210']);
    expect((await listTimesheetSubmissions(harness.as(master), SIPHO)).map((row) => [row.label, row.current])).toEqual([
      ['Thu 26 Nov 2026 – Tue 15 Dec 2026', true],
      ['Sun 1 Nov 2026 – Wed 25 Nov 2026', true],
    ]);
  });

  it('a submission inside another, and one straddling two, are refused too', async () => {
    await add('2026-11-05', 'L-1105');
    await submit('2026-11-01', '2026-11-25');
    await submit('2026-11-26', '2026-12-25');
    const before = await state();
    await expect(submit('2026-11-10', '2026-11-15', true)).rejects.toMatchObject({ violations: [{ code: 'timesheet_partial_overlap' }] });
    await expect(submit('2026-11-01', '2026-12-10', true)).rejects.toMatchObject({ violations: [{ code: 'timesheet_partial_overlap' }] });
    expect(await state()).toEqual(before);
  });

  it('dates covering ALL of it replace it — only when confirmed — and every line it held is in the replacement', async () => {
    await add('2026-11-05', 'L-1105');
    await add('2026-11-22', 'L-1122');
    const existing = await submit('2026-11-01', '2026-11-25');
    await add('2026-12-10', 'L-1210');
    const before = await state();
    await expect(submit('2026-10-26', '2026-12-15')).rejects.toMatchObject({
      message: expect.stringContaining('(2 lines)') as unknown,
      violations: [{ code: 'timesheet_replace_unconfirmed' }],
    });
    expect(await state()).toEqual(before);
    const replacement = await submit('2026-10-26', '2026-12-15', true);
    // No submitted line leaves payroll coverage: all of the old snapshot's lines are in the new one.
    expect(await tagsOf(replacement.id)).toEqual(['L-1105', 'L-1122', 'L-1210']);
    const kept = await harness.repos.attendance.findPeriodById(existing.id);
    expect(kept?.supersededAt).toBeTruthy();
    expect(kept?.snapshot).toEqual(existing.snapshot);
    const trail = (await harness.repos.activity.list()).filter((event) => event.type === 'timesheet_submitted');
    expect(trail.some((event) => event.detail.includes('replaces the overlapping submission Sun 1 Nov 2026 – Wed 25 Nov 2026'))).toBe(true);
    // Nothing of it is back on the open sheet: covered by the replacement.
    expect((await loadWorkingTimesheet(harness.as(sipho), SIPHO)).entries).toEqual([]);
  });

  it('a submission with a correction (pending or accepted) is not replaced: corrections stay the way to change it', async () => {
    const line = await add('2026-11-05', 'L-1105');
    const existing = await submit('2026-11-01', '2026-11-25');
    const correction = await requestTimesheetCorrection(harness.as(sipho), SIPHO, {
      from: '2026-11-01', to: '2026-11-25', reason: 'OT was 2', comment: '',
      lines: [{ entryId: line.id, date: '2026-11-05', customerName: 'L-1105', overtimeHours: 2, doubleHours: 0 }],
    });
    await expect(submit('2026-10-26', '2026-12-15', true)).rejects.toMatchObject({ violations: [{ code: 'timesheet_replace_corrected' }] });
    await decideTimesheetCorrection(harness.as(coordinator), SIPHO, correction.id, { decision: 'accept' });
    await expect(submit('2026-10-26', '2026-12-15', true)).rejects.toMatchObject({ violations: [{ code: 'timesheet_replace_corrected' }] });
    expect((await harness.repos.attendance.findPeriodById(existing.id))?.supersededAt ?? null).toBeNull();
  });
});

describe('TS-PAPER-8 — the original is always readable; a replaced submission takes no correction', () => {
  it('after an accepted correction and after replacement, technician and office read the complete original and the corrected version, each labelled', async () => {
    const line = await add('2026-11-05', 'L-1105');
    await add('2026-11-06', 'L-1106');
    const corrected = await submit('2026-11-01', '2026-11-10');
    const correction = await requestTimesheetCorrection(harness.as(sipho), SIPHO, {
      from: '2026-11-01', to: '2026-11-10', reason: 'wrong customer', comment: '',
      lines: [{ entryId: line.id, date: '2026-11-05', customerName: 'L-9999', overtimeHours: 1, doubleHours: 0 }],
    });
    await decideTimesheetCorrection(harness.as(coordinator), SIPHO, correction.id, { decision: 'accept' });
    for (const reader of [sipho, master]) {
      const original = await loadSubmissionDocument(harness.as(reader), corrected.id, 'original');
      const current = await loadSubmissionDocument(harness.as(reader), corrected.id);
      expect(original.rows.map((row) => row.customer)).toEqual(['L-1105', 'L-1106']);
      expect(original.versionLabel).toMatch(/^Original submission — superseded by an accepted correction/u);
      expect(current.rows.map((row) => row.customer)).toEqual(['L-9999']);
      expect(current.versionLabel).toMatch(/^Correction 1, accepted/u);
    }

    // A second submission, replaced by one covering it: its original stays readable, marked replaced.
    await add('2026-11-20', 'L-1120');
    const replaced = await submit('2026-11-15', '2026-11-25');
    await submit('2026-11-11', '2026-11-30', true);
    for (const reader of [sipho, master]) {
      const original = await loadSubmissionDocument(harness.as(reader), replaced.id, 'original');
      expect(original.rows.map((row) => row.customer)).toEqual(['L-1120']);
      expect(original.versionLabel).toMatch(/replaced by a later submission on 2027-01-27$/u);
    }
    // Another technician reads neither.
    await expect(loadSubmissionDocument(harness.as(riaan), replaced.id, 'original')).rejects.toMatchObject({ violations: [{ code: 'submission_not_found' }] });
    // A replaced submission takes no new correction request.
    await expect(requestTimesheetCorrection(harness.as(sipho), SIPHO, {
      from: '2026-11-15', to: '2026-11-25', reason: 'too late', comment: '', lines: [],
    })).rejects.toMatchObject({ violations: [{ code: 'timesheet_replaced' }] });
  });
});

describe('TS-PAPER-7 — Finance: every submitted line once, none missing, none twice', () => {
  /** A month submitted before TS-PAPER: its calendar-month timesheet, and the monthly submission naming it. */
  const legacyMonth = async (month: string, to: string) => {
    const period = await submit(`${month}-01`, to);
    await harness.repos.payroll.createSubmission({
      id: `msb-legacy-${month}`, userId: SIPHO, month, timesheetPeriodId: period.id,
      attendance: { technicianName: 'Sipho Mahlangu', month, days: [] }, submittedAt: `${to}T18:00:00.000Z`, submittedBy: SIPHO,
    });
    return period;
  };

  it('a legacy calendar month followed by payday submissions crossing month boundaries', async () => {
    for (const [date, tag] of [['2026-10-05', 'L-1005'], ['2026-10-28', 'L-1028'], ['2026-11-25', 'L-1125'], ['2026-12-15', 'L-1215'], ['2026-12-18', 'L-1218'], ['2027-01-25', 'L-0125']] as const) await add(date, tag);
    await legacyMonth('2026-10', '2026-10-31');
    await submit('2026-11-01', '2026-11-25');
    await submit('2026-11-26', '2026-12-15');
    await submit('2026-12-16', '2027-01-25');
    const printed = [
      ...(await packageOf('2026-10')).tags,
      ...(await packageOf('2026-11')).tags,
      ...(await packageOf('2026-12')).tags,
      ...(await packageOf('2027-01')).tags,
    ].sort();
    expect(printed).toEqual(['L-0125', 'L-1005', 'L-1028', 'L-1125', 'L-1215', 'L-1218']);
  });

  it('a legacy calendar month REPLACED by a payday submission covering it is never printed beside it', async () => {
    for (const [date, tag] of [['2026-09-28', 'L-0928'], ['2026-10-05', 'L-1005'], ['2026-10-28', 'L-1028'], ['2026-11-20', 'L-1120']] as const) await add(date, tag);
    const legacy = await legacyMonth('2026-10', '2026-10-31');
    // 26 Sep – 25 Nov covers every day of October: confirmed, it replaces the calendar month.
    await submit('2026-09-26', '2026-11-25', true);
    const october = await packageOf('2026-10');
    const november = await packageOf('2026-11');
    expect(october.sheets).toEqual([]);
    expect(november.sheets.map((sheet) => sheet.tags)).toEqual([['L-0928', 'L-1005', 'L-1028', 'L-1120']]);
    // The legacy snapshot and its monthly submission are kept exactly as they were.
    expect((await harness.repos.attendance.findPeriodById(legacy.id))?.snapshot).toEqual(legacy.snapshot);
    expect((await harness.repos.payroll.findSubmission(SIPHO, '2026-10'))?.timesheetPeriodId).toBe(legacy.id);
  });

  it('an accepted correction is printed in force; a correction waiting holds the month back', async () => {
    const line = await add('2026-11-10', 'L-1110');
    await submit('2026-10-26', '2026-11-25');
    const correction = await requestTimesheetCorrection(harness.as(sipho), SIPHO, {
      from: '2026-10-26', to: '2026-11-25', reason: 'customer', comment: '',
      lines: [{ entryId: line.id, date: '2026-11-10', customerName: 'L-9999', overtimeHours: 1, doubleHours: 0 }],
    });
    await submitMonth(harness.as(sipho), SIPHO, '2026-11', { confirmUnrecorded: true });
    await expect(prepareFinancePackage(harness.as(master), '2026-11', [SIPHO])).rejects.toMatchObject({ violations: [{ code: 'payroll_correction_pending' }] });
    await decideTimesheetCorrection(harness.as(coordinator), SIPHO, correction.id, { decision: 'accept' });
    expect((await packageOf('2026-11')).tags).toEqual(['L-9999']);
  });

  it('a 250-line timesheet prints on several pages with correct totals, and Finance accepts it beside a one-page attendance', async () => {
    const start = Date.parse('2026-10-26T00:00:00Z');
    for (let index = 0; index < 250; index += 1) {
      const date = new Date(start + Math.floor(index / 3) * 86_400_000).toISOString().slice(0, 10);
      await add(date, `L-${String(index).padStart(4, '0')}`, 1.25);
    }
    const sent = await submit('2026-10-26', '2027-01-25');
    const document = await loadSubmissionDocument(harness.as(master), sent.id);
    expect(document.rows).toHaveLength(250);
    expect(document.totals.overtimeHours).toBe(312.5);
    const rendered = renderTimesheetPdf(document, { generatedAt: '2027-01-27T06:00:00.000Z' });
    expect(rendered.layout).toBeNull();
    expect(rendered.pageCount).toBeGreaterThan(1);
    const pages = pdfPageTexts(rendered.bytes).map((page) => page.replace(/\s+/gu, ' '));
    expect(pages).toHaveLength(rendered.pageCount);
    pages.forEach((page, index) => {
      expect(page).toContain(`Page ${index + 1} of ${pages.length}`);
      expect(page).toContain('Cust Km');
    });
    // Every line once; the totals (of all 250 lines) after the last one.
    const tags = pages.join(' ').match(/L-\d{4}/gu) ?? [];
    expect(new Set(tags).size).toBe(250);
    expect(tags).toHaveLength(250);
    expect(pages.at(-1)).toContain('312.50');
    const finance = await packageOf('2027-01');
    expect(finance.sheets).toHaveLength(1);
    expect(finance.sheets[0]!.pages).toBe(rendered.pageCount);
    expect(finance.sheets[0]!.tags).toHaveLength(250);
    expect(finance.attendancePages).toEqual([1]);
  });
});
