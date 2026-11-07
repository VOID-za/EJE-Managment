import { beforeEach, describe, expect, it } from 'vitest';
import { asUserId, type TimesheetPeriod } from '@/domain';
import { pdfPageTexts, pdfPlainText } from '@/lib/pdf/inspect';
import { renderTimesheetPdf } from '@/services/simulated/timesheet-pdf';
import {
  listTimesheetSubmissions,
  loadSubmissionDocument,
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
 *   7. (Replaced by REPEAT-DATES-1, 7 November 2026.) The same date may be in
 *      several submitted timesheets; each LINE is in one only, and an earlier
 *      submission is never replaced or rewritten. A v1.6.0 replacement already
 *      stored is still read as it was.
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
const submit = (from: string, to: string) => submitTimesheetPeriod(harness.as(sipho), SIPHO, from, to);
const tagsOf = async (id: string, version: 'current' | 'original' = 'current') =>
  (await loadSubmissionDocument(harness.as(master), id, version)).rows.map((row) => row.customer).sort();
/** The month's Finance package: the attendance submitted, prepared, every timesheet attachment read, then discarded. */
const packageOf = async (month: string) => {
  // A month submitted before PAYROLL-ONE-1 is never submitted again (0052).
  if ((await harness.repos.payroll.findSubmission(SIPHO, month)) === null) await submitMonth(harness.as(sipho), SIPHO, month, { confirmUnrecorded: true });
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

/**
 * A v1.6.0 REPLACEMENT, as production stores it (TS-PAPER-7 replaced a covered submission; REPEAT-DATES-1 retired
 * that on 7 November 2026): the earlier periods marked replaced, and the replacement carrying every line of these
 * dates. Seeded directly — no rule makes one any more.
 */
const seedReplacement = async (from: string, to: string): Promise<TimesheetPeriod> => {
  const entries = await harness.repos.attendance.listEntries(SIPHO, from, to);
  const at = '2027-01-27T06:00:00.000Z';
  const replacement: TimesheetPeriod = {
    id: `tsp-replacement-${from}`, userId: SIPHO, from, to, comment: '', updatedBy: SIPHO, updatedAt: at, submittedAt: at, submittedBy: SIPHO,
    snapshot: { technicianName: 'Sipho Mahlangu', from, to, comment: '', entries }, supersededAt: null, supersededBy: null,
  };
  harness.seedHistory((draft) => {
    draft.timesheetPeriods = [
      ...draft.timesheetPeriods.map((row) =>
        row.userId === SIPHO && row.submittedAt !== null && (row.supersededAt ?? null) === null && from <= row.from && row.to <= to ? { ...row, supersededAt: at, supersededBy: SIPHO } : row,
      ),
      replacement,
    ];
  });
  return replacement;
};

describe('REPEAT-DATES-1 — the same date in more than one submitted timesheet; each LINE once', () => {
  it('the owner’s example: 1–25 Nov submitted, then 20 Nov–15 Dec is ACCEPTED — the earlier one untouched, no line in both', async () => {
    await add('2026-11-05', 'L-1105');
    await add('2026-11-22', 'L-1122');
    await add('2026-12-10', 'L-1210');
    const existing = await submit('2026-11-01', '2026-11-25');
    const kept = await harness.repos.attendance.findPeriodById(existing.id);
    // A new line on 22 November — a date already submitted — is accepted for the next timesheet.
    await add('2026-11-22', 'L-1122B');
    const next = await submit('2026-11-20', '2026-12-15');
    expect(next.id).not.toBe(existing.id);
    expect(await tagsOf(next.id)).toEqual(['L-1122B', 'L-1210']);
    expect(await tagsOf(existing.id)).toEqual(['L-1105', 'L-1122']);
    // The earlier submission is exactly as it was: never replaced, never rewritten.
    expect(await harness.repos.attendance.findPeriodById(existing.id)).toEqual(kept);
    expect((await listTimesheetSubmissions(harness.as(master), SIPHO)).map((row) => [row.label, row.current, row.lineCount])).toEqual([
      ['Fri 20 Nov 2026 – Tue 15 Dec 2026', true, 2],
      ['Sun 1 Nov 2026 – Wed 25 Nov 2026', true, 2],
    ]);
    const trail = (await harness.repos.activity.list()).filter((event) => event.type === 'timesheet_submitted');
    expect(trail.some((event) => event.detail.includes('repeat days of the submitted timesheet Sun 1 Nov 2026 – Wed 25 Nov 2026'))).toBe(true);
  });

  it('exactly the same dates again: a second submission of its own, with only the lines not yet submitted', async () => {
    const first = await add('2026-11-05', 'L-1105');
    const a = await submit('2026-11-01', '2026-11-25');
    expect(await tagsOf(a.id)).toEqual(['L-1105']);
    await add('2026-11-05', 'L-1105B');
    const b = await submit('2026-11-01', '2026-11-25');
    expect(b.id).not.toBe(a.id);
    expect(await tagsOf(b.id)).toEqual(['L-1105B']);
    expect(await tagsOf(a.id)).toEqual(['L-1105']);
    // A submitted line is never changed, moved or removed — whatever date is open now.
    await expect(
      saveTimesheetEntry(harness.as(sipho), SIPHO, { entryId: first.id, date: '2026-11-05', customerName: 'L-1105', overtimeHours: 5, doubleHours: 0 }),
    ).rejects.toMatchObject({ violations: [{ code: 'timesheet_line_submitted' }] });
    // Nothing left: a third submission of these dates carries no line at all.
    expect(await tagsOf((await submit('2026-11-01', '2026-11-25')).id)).toEqual([]);
  });

  it('the same LINE is never in two submissions: the store refuses it (as the database’s line ledger does)', async () => {
    const line = await add('2026-11-05', 'L-1105');
    const sent = await submit('2026-11-01', '2026-11-25');
    await expect(
      harness.repos.attendance.submitPeriod({
        ...sent, id: 'tsp-twice', submittedAt: '2027-01-27T07:00:00.000Z',
        snapshot: { technicianName: 'Sipho Mahlangu', from: '2026-11-01', to: '2026-11-25', comment: '', entries: [line] },
      }),
    ).rejects.toThrow(/already in a submitted timesheet/u);
    expect((await harness.repos.attendance.listSubmissions(SIPHO)).map((period) => period.id)).toEqual([sent.id]);
  });

  it('a corrected submission keeps its correction: a later submission of the same dates never carries its lines', async () => {
    const line = await add('2026-11-05', 'L-1105');
    const existing = await submit('2026-11-01', '2026-11-25');
    const correction = await requestTimesheetCorrection(harness.as(sipho), SIPHO, {
      from: '2026-11-01', to: '2026-11-25', periodId: existing.id, reason: 'OT was 2', comment: '',
      lines: [{ entryId: line.id, date: '2026-11-05', customerName: 'L-1105', overtimeHours: 2, doubleHours: 0 }],
    });
    await decideTimesheetCorrection(harness.as(coordinator), SIPHO, correction.id, { decision: 'accept' });
    const later = await submit('2026-10-26', '2026-12-15');
    expect(await tagsOf(later.id)).toEqual([]);
    expect((await harness.repos.attendance.findPeriodById(existing.id))?.supersededAt ?? null).toBeNull();
    expect((await loadSubmissionDocument(harness.as(master), existing.id)).rows.map((row) => row.overtimeHours)).toEqual([2]);
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
    await seedReplacement('2026-11-11', '2026-11-30');
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
    // 26 Sep – 25 Nov covered every day of October: under v1.6.0, confirmed, it replaced the calendar month.
    await seedReplacement('2026-09-26', '2026-11-25');
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
