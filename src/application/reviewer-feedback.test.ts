import { beforeEach, describe, expect, it } from 'vitest';
import { asUserId, getJobTypeDefinition, type Job, type TimesheetEntry } from '@/domain';
import { businessToday } from '@/lib/business-time';
import { pdfPlainText } from '@/lib/pdf/inspect';
import {
  defaultTimesheetRange,
  formatDayAndDate,
  formatPeriod,
  timesheetRangeProblem,
  weekdayOf,
} from '@/lib/timesheet-dates';
import { renderTimesheetPdf, TIMESHEET_PDF_COLUMNS, timesheetPdfCells } from '@/services/simulated/timesheet-pdf';
import { formatCurrency } from '@/lib/format';

import { SimulatedPdfService } from '@/services/simulated/pdf';
import { renderJobCardPdf } from '@/components/jobs/job-card-pdf';
import { recordAttendance } from './attendance-operations';
import {
  loadTimesheet,
  loadTimesheetDocument,
  removeTimesheetEntry,
  saveTimesheetComment,
  saveTimesheetEntry,
  saveTimesheetPeriodComment,
  submitTimesheetPeriod,
} from './timesheets';
import {
  acceptJob,
  addLabour,
  addPart,
  cancelCompletion,
  removeLineItem,
  saveCompletionReport,
  setCollectionMethod,
  startCompletion,
  updatePart,
} from './job-operations';
import { createJob } from './job-creation';
import { loadJobView } from './job-view';
import { generateDeliveryNote } from './delivery-note';
import { buildHarness, seedUser, type Harness } from './test-harness';

/**
 * THE REAL-WORLD REVIEWER'S FEEDBACK OF 28 OCTOBER 2026.
 *
 * One file, one describe per requirement ID in
 * docs/reviewer-feedback-2026-10-28.md, so a row of the matrix can be traced to
 * the test that proves it. Every rule is proved at the operation — the server —
 * because hiding a button is not a rule.
 */
const SIPHO = asUserId('user-tech-sipho');
const sipho = seedUser('user-tech-sipho');
const riaan = seedUser('user-tech-riaan');
const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');

const day = (offset: number): string => {
  const date = new Date(`${businessToday()}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
};

const line = (date: string, overrides: Record<string, unknown> = {}) => ({
  date,
  customerName: 'ABC Engineering',
  overtimeHours: 1.5,
  doubleHours: 0,
  calloutAmount: 45000,
  calloutShared: false,
  internalKm: 12.5,
  customerKm: 40,
  ...overrides,
});

let harness: Harness;
beforeEach(() => {
  harness = buildHarness();
});

const events = async (type: string) =>
  (await harness.repos.activity.list()).filter((event) => event.type === type);

// ---------------------------------------------------------------------------
describe('ATT-01 — absence reasons', () => {
  it('an absent day needs one of exactly four reasons; a present day takes none', async () => {
    const context = harness.as(sipho);
    await expect(
      recordAttendance(context, { userId: SIPHO, date: day(1), status: 'absent', note: '' }),
    ).rejects.toMatchObject({ violations: [{ code: 'absence_reason_required' }] });
    await expect(
      recordAttendance(context, { userId: SIPHO, date: day(1), status: 'absent', absenceReason: 'holiday', note: '' }),
    ).rejects.toMatchObject({ violations: [{ code: 'invalid_absence_reason' }] });
    await expect(
      recordAttendance(context, { userId: SIPHO, date: day(1), status: 'present', absenceReason: 'leave', note: '' }),
    ).rejects.toMatchObject({ violations: [{ code: 'absence_reason_not_applicable' }] });

    for (const [offset, reason] of [[1, 'leave'], [2, 'sick_leave'], [3, 'family_responsibility'], [4, 'iod']] as const) {
      const saved = await recordAttendance(context, { userId: SIPHO, date: day(offset), status: 'absent', absenceReason: reason, note: '' });
      expect(saved.absenceReason).toBe(reason);
    }
    const present = await recordAttendance(context, { userId: SIPHO, date: day(5), status: 'present', note: '' });
    expect(present.absenceReason).toBeNull();
  });

  it('an absent day from before the reason existed keeps none; changing the reason is on the audit trail', async () => {
    // An old record, written as the register held it before 28 October.
    await harness.repos.attendance.saveRecord({
      id: 'att-old', userId: SIPHO, date: day(6), status: 'absent', absenceReason: null, note: 'flu',
      recordedBy: SIPHO, recordedAt: '2026-10-01T08:00:00.000Z',
    });
    expect((await harness.repos.attendance.findRecord(SIPHO, day(6)))?.absenceReason).toBeNull();

    const context = harness.as(sipho);
    await recordAttendance(context, { userId: SIPHO, date: day(7), status: 'absent', absenceReason: 'leave', note: '' });
    await recordAttendance(context, { userId: SIPHO, date: day(7), status: 'absent', absenceReason: 'iod', note: '' });
    const corrected = (await events('attendance_corrected')).at(-1);
    expect(corrected?.changes).toEqual([{ field: 'Absence reason', from: 'Leave', to: 'IOD (Injury on Duty)' }]);
  });

  it('the office records an absence with a reason too', async () => {
    const saved = await recordAttendance(harness.as(coordinator), {
      userId: SIPHO, date: day(1), status: 'absent', absenceReason: 'sick_leave', note: '',
    });
    expect(saved.absenceReason).toBe('sick_leave');
  });
});

describe('ATT-02 — attendance permissions are unchanged', () => {
  it('a technician cannot record another technician’s day', async () => {
    await expect(
      recordAttendance(harness.as(riaan), { userId: SIPHO, date: day(1), status: 'present', note: '' }),
    ).rejects.toMatchObject({ violations: [{ code: 'not_permitted' }] });
  });
});

// ---------------------------------------------------------------------------
describe('TS-01 — a technician’s timesheet is theirs', () => {
  it('another technician can neither read nor write it; the office reads it and cannot write it', async () => {
    await expect(loadTimesheet(harness.as(riaan), SIPHO, day(2), day(0))).rejects.toMatchObject({ violations: [{ code: 'not_permitted' }] });
    await expect(saveTimesheetEntry(harness.as(riaan), SIPHO, line(day(0)))).rejects.toMatchObject({ violations: [{ code: 'not_permitted' }] });
    expect((await loadTimesheet(harness.as(master), SIPHO, day(2), day(0))).editable).toBe(false);
    await expect(saveTimesheetEntry(harness.as(master), SIPHO, line(day(0)))).rejects.toMatchObject({ violations: [{ code: 'not_permitted' }] });
    await expect(loadTimesheetDocument(harness.as(riaan), SIPHO, day(6), day(2))).rejects.toMatchObject({ violations: [{ code: 'not_permitted' }] });
    await expect(submitTimesheetPeriod(harness.as(riaan), SIPHO, day(6), day(2))).rejects.toMatchObject({ violations: [{ code: 'not_permitted' }] });
    await expect(submitTimesheetPeriod(harness.as(master), SIPHO, day(6), day(2))).rejects.toMatchObject({ violations: [{ code: 'not_permitted' }] });
  });
});

describe('TS-04 / TS-05 — dates, order and the day of the week', () => {
  it('weekdays come from the calendar date, never shifted by a time zone', () => {
    expect(weekdayOf('2026-10-26')).toBe('Mon');
    expect(weekdayOf('2026-11-01')).toBe('Sun');
    expect(weekdayOf('2024-02-29')).toBe('Thu');
    expect(formatDayAndDate('2026-10-26')).toBe('Mon 26 Oct 2026');
  });

  it('a period prints as its two days, across a year end, a leap day and a single day', () => {
    expect(formatPeriod('2026-12-28', '2027-01-03')).toBe('Mon 28 Dec 2026 – Sun 3 Jan 2027');
    expect(formatPeriod('2024-02-28', '2024-03-01')).toBe('Wed 28 Feb 2024 – Fri 1 Mar 2024');
    expect(formatPeriod('2026-10-26', '2026-10-26')).toBe('Mon 26 Oct 2026');
  });

  it('the page opens on the first of the month to today, and an impossible range is said, not queried', () => {
    expect(defaultTimesheetRange('2026-10-28')).toEqual({ from: '2026-10-01', to: '2026-10-28' });
    expect(timesheetRangeProblem('2026-10-28', '2026-10-01', 92)).toBe('From must be on or before To.');
    expect(timesheetRangeProblem('2026-10-01', '', 92)).toBe('Choose both a From and a To date.');
    expect(timesheetRangeProblem('2026-01-01', '2026-12-31', 92)).toMatch(/at most 92/);
    expect(timesheetRangeProblem('2026-10-01', '2026-10-01', 92)).toBeNull();
  });

  it('the sheet is OLDEST FIRST, each day with its weekday; an empty range is empty, not an error', async () => {
    await saveTimesheetEntry(harness.as(sipho), SIPHO, line(day(0)));
    await saveTimesheetEntry(harness.as(sipho), SIPHO, line(day(3)));
    const sheet = await loadTimesheet(harness.as(sipho), SIPHO, day(4), day(0));
    expect(sheet.days.map((entry) => entry.date)).toEqual([day(4), day(3), day(2), day(1), day(0)]);
    expect(sheet.days.every((entry) => entry.weekday === weekdayOf(entry.date))).toBe(true);
    const empty = await loadTimesheet(harness.as(sipho), SIPHO, day(40), day(35));
    expect(empty.days.every((entry) => !entry.recorded)).toBe(true);
    await expect(loadTimesheet(harness.as(sipho), SIPHO, day(0), day(4))).rejects.toMatchObject({ violations: [{ code: 'invalid_range' }] });
  });
});

describe('TS-06 — Workshop', () => {
  it('is chosen, not typed; it is not a customer and cannot be one at the same time', async () => {
    const saved = await saveTimesheetEntry(harness.as(sipho), SIPHO, line(day(0), { customerName: '', workshop: true }));
    expect(saved).toMatchObject({ workshop: true, customerId: null, customerName: '' });
    await expect(
      saveTimesheetEntry(harness.as(sipho), SIPHO, line(day(0), { workshop: true, customerName: 'ABC' })),
    ).rejects.toMatchObject({ violations: [{ code: 'workshop_and_customer' }] });
    await expect(
      saveTimesheetEntry(harness.as(sipho), SIPHO, line(day(0), { customerName: '' })),
    ).rejects.toMatchObject({ violations: [{ code: 'customer_required' }] });
    // No fake customer was created.
    const customers = await harness.repos.customers.list();
    expect(customers.some((customer) => customer.name === 'Workshop')).toBe(false);
  });
});

describe('TS-07 — NT is no longer entered; OT and DT are', () => {
  it('a new line refuses NT, keeps OT and DT', async () => {
    await expect(
      saveTimesheetEntry(harness.as(sipho), SIPHO, line(day(0), { normalHours: 8 })),
    ).rejects.toMatchObject({ violations: [{ code: 'nt_not_entered' }] });
    const saved = await saveTimesheetEntry(harness.as(sipho), SIPHO, line(day(0), { overtimeHours: 2, doubleHours: 1.25 }));
    expect(saved).toMatchObject({ normalHours: 0, overtimeHours: 2, doubleHours: 1.25 });
  });

  it('a line written before keeps its NT on correction — never moved into OT or DT', async () => {
    const old: TimesheetEntry = {
      id: 'tse-old', userId: SIPHO, date: day(1), customerId: null, customerName: 'Kruger', workshop: false,
      normalHours: 8, overtimeHours: 0, doubleHours: 0, callouts: 1, calloutAmount: 0, calloutShared: false,
      internalKm: 0, customerKm: 0, updatedBy: SIPHO, updatedAt: '2026-10-20T08:00:00.000Z',
    };
    await harness.repos.attendance.saveEntry(old);
    const corrected = await saveTimesheetEntry(harness.as(sipho), SIPHO, {
      ...line(day(1), { customerName: 'Kruger', overtimeHours: 1 }), entryId: 'tse-old', normalHours: 8, callouts: 1,
    });
    expect(corrected).toMatchObject({ normalHours: 8, callouts: 1, overtimeHours: 1, doubleHours: 0 });
    await expect(
      saveTimesheetEntry(harness.as(sipho), SIPHO, { ...line(day(1)), entryId: 'tse-old', normalHours: 0 }),
    ).rejects.toMatchObject({ violations: [{ code: 'nt_not_entered' }] });
  });
});

describe('TS-08 — the call-out is a rand amount', () => {
  it('in whole cents, validated; a shared call-out is recorded as entered, never divided', async () => {
    for (const bad of [-100, 12.5, 100_000_001]) {
      await expect(
        saveTimesheetEntry(harness.as(sipho), SIPHO, line(day(0), { calloutAmount: bad })),
      ).rejects.toMatchObject({ violations: [{ code: 'invalid_callout_amount' }] });
    }
    await expect(
      saveTimesheetEntry(harness.as(sipho), SIPHO, line(day(0), { calloutAmount: 0, calloutShared: true })),
    ).rejects.toMatchObject({ violations: [{ code: 'callout_shared_without_amount' }] });
    await expect(
      saveTimesheetEntry(harness.as(sipho), SIPHO, line(day(0), { callouts: 2 })),
    ).rejects.toMatchObject({ violations: [{ code: 'callout_count_withdrawn' }] });
    const a = await saveTimesheetEntry(harness.as(sipho), SIPHO, line(day(0), { calloutAmount: 90000, calloutShared: true }));
    const b = await saveTimesheetEntry(harness.as(sipho), SIPHO, line(day(0), { customerName: 'Kruger', calloutAmount: 90000, calloutShared: true }));
    expect([a.calloutAmount, b.calloutAmount]).toEqual([90000, 90000]);
    const sheet = await loadTimesheet(harness.as(sipho), SIPHO, day(0), day(0));
    expect(sheet.totals.calloutAmount).toBe(180000);
  });
});

describe('TS-09 — internal and customer kilometres', () => {
  it('saved, read back and validated separately, to one decimal', async () => {
    const saved = await saveTimesheetEntry(harness.as(sipho), SIPHO, line(day(0), { internalKm: 7.5, customerKm: 102.3 }));
    expect(saved).toMatchObject({ internalKm: 7.5, customerKm: 102.3 });
    const sheet = await loadTimesheet(harness.as(sipho), SIPHO, day(0), day(0));
    expect(sheet.days[0]).toMatchObject({ internalKm: 7.5, customerKm: 102.3 });
    await expect(saveTimesheetEntry(harness.as(sipho), SIPHO, line(day(0), { internalKm: 1.25 }))).rejects.toMatchObject({ violations: [{ code: 'invalid_internal_km' }] });
    await expect(saveTimesheetEntry(harness.as(sipho), SIPHO, line(day(0), { customerKm: -1 }))).rejects.toMatchObject({ violations: [{ code: 'invalid_customer_km' }] });
  });
});

/** A chosen period, inside the last week: the owner's From/To decision. */
const FROM = day(6);
const TO = day(2);

describe('TS-10 / TS-12 — one comment for the timesheet period; Save is not a submission', () => {
  it('saves and changes the period’s comment; an unchanged comment writes nothing', async () => {
    const saved = await saveTimesheetPeriodComment(harness.as(sipho), SIPHO, FROM, TO, 'Waited for the crane on the 14th.');
    expect(saved).toMatchObject({ from: FROM, to: TO, comment: 'Waited for the crane on the 14th.', submittedAt: null });
    const before = (await events('timesheet_comment_saved')).length;
    await saveTimesheetPeriodComment(harness.as(sipho), SIPHO, FROM, TO, 'Waited for the crane on the 14th.');
    expect((await events('timesheet_comment_saved')).length).toBe(before);
    expect((await loadTimesheetDocument(harness.as(master), SIPHO, FROM, TO)).comment).toBe('Waited for the crane on the 14th.');
    // The exact period: another range has its own comment.
    expect((await loadTimesheetDocument(harness.as(master), SIPHO, FROM, day(1))).comment).toBe('');
    await expect(saveTimesheetPeriodComment(harness.as(master), SIPHO, FROM, TO, 'x')).rejects.toMatchObject({ violations: [{ code: 'not_permitted' }] });
  });
});

describe('TS-02 / TS-03 / TS-14 — Send to office, for the chosen period', () => {
  it('records the submission once, audited, with the content frozen; the period is then read-only on every path', async () => {
    const inside = await saveTimesheetEntry(harness.as(sipho), SIPHO, line(day(4)));
    const before = await saveTimesheetEntry(harness.as(sipho), SIPHO, line(day(8)));
    await saveTimesheetPeriodComment(harness.as(sipho), SIPHO, FROM, TO, 'All in order.');
    const sent = await submitTimesheetPeriod(harness.as(sipho), SIPHO, FROM, TO);
    expect(sent).toMatchObject({ from: FROM, to: TO, submittedBy: SIPHO });
    expect(sent.submittedAt).not.toBeNull();
    // Exactly the lines inside the period, boundaries included, and the comment.
    expect(sent.snapshot?.entries.map((entry) => entry.id)).toEqual([inside.id]);
    expect(sent.snapshot).toMatchObject({ from: FROM, to: TO, comment: 'All in order.' });
    expect((await events('timesheet_submitted')).length).toBe(1);

    const refusedCode = { violations: [{ code: 'timesheet_submitted' }] };
    await expect(saveTimesheetEntry(harness.as(sipho), SIPHO, line(day(4)))).rejects.toMatchObject(refusedCode);
    await expect(saveTimesheetEntry(harness.as(sipho), SIPHO, line(FROM))).rejects.toMatchObject(refusedCode);
    await expect(saveTimesheetEntry(harness.as(sipho), SIPHO, line(TO))).rejects.toMatchObject(refusedCode);
    await expect(saveTimesheetEntry(harness.as(sipho), SIPHO, { ...line(day(4), { overtimeHours: 3 }), entryId: inside.id })).rejects.toMatchObject(refusedCode);
    await expect(removeTimesheetEntry(harness.as(sipho), SIPHO, inside.id)).rejects.toMatchObject(refusedCode);
    await expect(saveTimesheetPeriodComment(harness.as(sipho), SIPHO, FROM, TO, 'changed')).rejects.toMatchObject(refusedCode);
    await expect(saveTimesheetComment(harness.as(sipho), SIPHO, day(4), 'day note')).rejects.toMatchObject(refusedCode);
    // A correction cannot move a line INTO the sent period either.
    await expect(saveTimesheetEntry(harness.as(sipho), SIPHO, { ...line(day(4)), entryId: before.id })).rejects.toMatchObject(refusedCode);
    // Days outside it stay open.
    expect((await saveTimesheetEntry(harness.as(sipho), SIPHO, line(day(1)))).date).toBe(day(1));
    // A second send — a double tap, a retry, another tab — is refused, not duplicated.
    await expect(submitTimesheetPeriod(harness.as(sipho), SIPHO, FROM, TO)).rejects.toMatchObject(refusedCode);
    expect((await events('timesheet_submitted')).length).toBe(1);

    // The office reads exactly what was sent.
    const document = await loadTimesheetDocument(harness.as(coordinator), SIPHO, FROM, TO);
    expect(document.submittedAt).toBe(sent.submittedAt);
    expect(document.comment).toBe('All in order.');
    expect(document.rows.filter((row) => row.recorded)).toHaveLength(1);
    const sheet = await loadTimesheet(harness.as(sipho), SIPHO, FROM, TO);
    expect(sheet.days.every((entry) => entry.locked)).toBe(true);
    expect(sheet.period).toMatchObject({ from: FROM, to: TO, submittedAt: sent.submittedAt });
  });

  it('a period sharing ANY day with a sent one is refused, so no work is sent twice', async () => {
    await saveTimesheetEntry(harness.as(sipho), SIPHO, line(day(4)));
    await submitTimesheetPeriod(harness.as(sipho), SIPHO, FROM, TO);
    const overlap = { violations: [{ code: 'period_overlaps_submitted' }] };
    await expect(submitTimesheetPeriod(harness.as(sipho), SIPHO, day(10), FROM)).rejects.toMatchObject(overlap);
    await expect(submitTimesheetPeriod(harness.as(sipho), SIPHO, TO, day(0))).rejects.toMatchObject(overlap);
    await expect(submitTimesheetPeriod(harness.as(sipho), SIPHO, day(5), day(3))).rejects.toMatchObject(overlap);
    await expect(saveTimesheetPeriodComment(harness.as(sipho), SIPHO, day(10), day(0), 'x')).rejects.toMatchObject(overlap);
    // The days either side are free: a period ending the day before is accepted.
    await saveTimesheetEntry(harness.as(sipho), SIPHO, line(day(8)));
    const next = await submitTimesheetPeriod(harness.as(sipho), SIPHO, day(9), day(7));
    expect(next).toMatchObject({ from: day(9), to: day(7) });
    // And the view says which sent periods overlap a wider range.
    const sheet = await loadTimesheet(harness.as(sipho), SIPHO, day(12), day(0));
    expect(sheet.period.overlapsSent).toEqual([{ from: day(9), to: day(7) }, { from: FROM, to: TO }]);
  });

  it('validates the period: From after To refused, a To after today refused, at most 92 days', async () => {
    await expect(submitTimesheetPeriod(harness.as(sipho), SIPHO, TO, FROM)).rejects.toMatchObject({ violations: [{ code: 'invalid_range' }] });
    const tomorrow = (() => { const d = new Date(`${businessToday()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
    await expect(submitTimesheetPeriod(harness.as(sipho), SIPHO, day(2), tomorrow)).rejects.toMatchObject({ violations: [{ code: 'period_in_future' }] });
    await expect(submitTimesheetPeriod(harness.as(sipho), SIPHO, day(120), day(0))).rejects.toMatchObject({ violations: [{ code: 'range_too_long' }] });
    // A one-day period is a period.
    expect(await submitTimesheetPeriod(harness.as(sipho), SIPHO, day(0), day(0))).toMatchObject({ from: day(0), to: day(0) });
  });

  it('tells the office — every active Master and Coordinator, once — only after the submission is saved', async () => {
    const officeIds = (await harness.repos.users.list())
      .filter((user) => (user.role === 'master' || user.role === 'coordinator') && user.active)
      .map((user) => user.id);
    const count = async () => {
      let total = 0;
      for (const id of officeIds) total += (await harness.repos.notifications.list(id)).filter((n) => n.type === 'timesheet_submitted').length;
      return total;
    };
    // A refused send notifies nobody.
    await expect(submitTimesheetPeriod(harness.as(sipho), SIPHO, TO, FROM)).rejects.toBeDefined();
    expect(await count()).toBe(0);
    await saveTimesheetEntry(harness.as(sipho), SIPHO, line(day(4)));
    await submitTimesheetPeriod(harness.as(sipho), SIPHO, FROM, TO);
    expect(await count()).toBe(officeIds.length);
    const one = (await harness.repos.notifications.list(officeIds[0]!)).find((n) => n.type === 'timesheet_submitted');
    expect(one?.title).toContain('Sipho');
    expect(one?.body).toContain(formatDayAndDate(FROM));
    expect(one?.link).toBe('/timesheets');
    // A second attempt is refused and notifies nobody again; nor is a technician told.
    await expect(submitTimesheetPeriod(harness.as(sipho), SIPHO, FROM, TO)).rejects.toBeDefined();
    expect(await count()).toBe(officeIds.length);
    expect((await harness.repos.notifications.list(riaan.id)).some((n) => n.type === 'timesheet_submitted')).toBe(false);
  });
});

describe('TS-11 / PDF-01…03 — Preview and the PDF Layout', () => {
  it('reading the document writes nothing: no period row, no audit event, no lock', async () => {
    await saveTimesheetEntry(harness.as(sipho), SIPHO, line(day(4)));
    const before = (await harness.repos.activity.list()).length;
    await loadTimesheetDocument(harness.as(sipho), SIPHO, FROM, TO);
    expect((await harness.repos.activity.list()).length).toBe(before);
    expect(await harness.repos.attendance.findPeriod(SIPHO, FROM, TO)).toBeNull();
  });

  it('prints Time Sheet, the Technician Name, the Period, EXACTLY the seven columns and the Comments box', async () => {
    await saveTimesheetEntry(harness.as(sipho), SIPHO, line(day(4), { customerName: '', workshop: true, overtimeHours: 2, doubleHours: 1, calloutAmount: 45000, internalKm: 10, customerKm: 37.5 }));
    await saveTimesheetPeriodComment(harness.as(sipho), SIPHO, FROM, TO, 'Bench work all day.');
    const document = await loadTimesheetDocument(harness.as(sipho), SIPHO, FROM, TO);
    const text = pdfPlainText(renderTimesheetPdf(document, { generatedAt: '2026-10-28T10:00:00.000Z' }).bytes);
    for (const expected of [
      // The period's two ends (the extractor drops the dash between them).
      'Time Sheet', 'Technician Name', 'Sipho', 'Period', formatDayAndDate(FROM), formatDayAndDate(TO),
      'Date', 'Customer', 'OT', 'D/T', 'Callout', 'Int Km', 'Cust Km', 'Comments', 'Bench work all day.',
      'Workshop', formatDayAndDate(day(4)), '2.00', '1.00', '10.0', '37.5',
    ]) {
      expect(text, expected).toContain(expected);
    }
    // Hm was never a requested field; NT is no longer entered.
    expect(text).not.toMatch(/\bHm\b/u);
    expect(text).not.toMatch(/\bNT\b/u);
    // The header, in order, is exactly the seven columns.
    expect(TIMESHEET_PDF_COLUMNS.map((column) => column.header)).toEqual(['Date', 'Customer', 'OT', 'D/T', 'Callout', 'Int Km', 'Cust Km']);
    // Every day of the period is on it, oldest first, boundaries included.
    expect(document.rows[0]?.date).toBe(FROM);
    expect(document.rows.at(-1)?.date).toBe(TO);
    expect(new Set(document.rows.map((row) => row.date)).size).toBe(5);
    // The row's cells align with the columns.
    const row = document.rows.find((candidate) => candidate.recorded)!;
    expect(timesheetPdfCells(row, true)).toEqual({
      date: formatDayAndDate(day(4)), customer: 'Workshop', ot: '2.00', dt: '1.00', callout: formatCurrency(45000), intKm: '10.0', custKm: '37.5',
    });
  });
});

// ---------------------------------------------------------------------------
const workshopJob = async (opts: { courier?: boolean; jobType?: 'test_and_repair' | 'breakdown' } = {}) => {
  const context = harness.as(master);
  const [customer] = await harness.repos.customers.list();
  const sites = await harness.repos.customers.listSites(customer!.id);
  const contacts = await harness.repos.customers.listContacts(customer!.id);
  const machines = await harness.repos.machines.list();
  let job = await createJob(context, {
    customerId: customer!.id, siteId: sites[0]!.id, contactId: contacts[0]!.id,
    machineId: opts.jobType === 'breakdown' ? machines.find((m) => m.siteId === sites[0]!.id)?.id ?? null : null,
    jobType: opts.jobType ?? 'test_and_repair', priority: opts.jobType === 'breakdown' ? 'normal' : null,
    scheduledDate: null, scheduledEndDate: null, additionalTechnicianIds: [], orderNumber: '', referenceNumber: 'REF-9',
    deliveryNote: '', faultDescription: opts.jobType === 'breakdown' ? 'Line down' : '', primaryTechnicianId: sipho.id,
    courierCollection: false, dateReceived: null,
    repairItem: { partNumber: 'A06B-6117', description: 'Spindle amplifier', quantity: 1 }, quoteNumber: 'Q-1',
  });
  const tech = harness.as(sipho);
  job = await acceptJob(tech, job);
  job = await addLabour(tech, job, { date: day(0), rateType: 'normal', hours: 2, description: '' });
  job = await addPart(tech, job, { partNumber: 'PSU-77', description: 'Power supply board', quantity: 2, unitPrice: 15000 });
  job = await saveCompletionReport(tech, job, { ...job.completionReport, workPerformed: 'Bench tested and repaired.' });
  return job;
};

describe('TR-01 — no part changes once a job is completed (every job type with an In Progress stage)', () => {
  it('adding, changing and removing a part are refused in completion; cancelling completion opens them again', async () => {
    let job = await workshopJob();
    const tech = harness.as(sipho);
    job = await startCompletion(tech, job);
    const locked = { violations: [{ code: 'parts_locked_after_completion' }] };
    await expect(addPart(tech, job, { partNumber: 'X', description: 'late', quantity: 1, unitPrice: 100 })).rejects.toMatchObject(locked);
    await expect(updatePart(tech, job, job.parts[0]!.id, { partNumber: 'PSU-77', description: 'changed', quantity: 3, unitPrice: 15000 })).rejects.toMatchObject(locked);
    await expect(removeLineItem(tech, job, 'part', job.parts[0]!.id)).rejects.toMatchObject(locked);
    // The office is held to the same rule before the signature.
    await expect(addPart(harness.as(master), job, { partNumber: 'X', description: 'late', quantity: 1, unitPrice: 100 })).rejects.toMatchObject(locked);
    expect((await harness.repos.jobs.findById(job.id))?.parts).toHaveLength(1);

    job = await cancelCompletion(tech, job);
    expect(job.status).toBe('in_progress');
    job = await addPart(tech, job, { partNumber: 'X', description: 'now allowed', quantity: 1, unitPrice: 100 });
    expect(job.parts).toHaveLength(2);
  });

  it('a breakdown is locked the same way now (the owner, 28 October 2026); labour is not part of the rule', async () => {
    let breakdown = await workshopJob({ jobType: 'breakdown' });
    breakdown = await startCompletion(harness.as(sipho), breakdown);
    await expect(
      addPart(harness.as(sipho), breakdown, { partNumber: 'B', description: 'late', quantity: 1, unitPrice: 100 }),
    ).rejects.toMatchObject({ violations: [{ code: 'parts_locked_after_completion' }] });
    const withLabour = await addLabour(harness.as(sipho), breakdown, { date: day(0), rateType: 'normal', hours: 1, description: '' });
    expect(withLabour.labour).toHaveLength(2);
  });
});

describe('PARTS-01 / PARTS-02 — Parts: order number optional, quote number offered', () => {
  it('the definition says so, and a Parts job is raised with a quote number and no order number', async () => {
    const parts = getJobTypeDefinition('parts');
    expect(parts.requiresOrderNumber).toBe(false);
    expect(parts.orderNumberExpectation).toBe('optional');
    expect(parts.capturesQuoteNumber).toBe(true);
    const [customer] = await harness.repos.customers.list();
    const sites = await harness.repos.customers.listSites(customer!.id);
    const contacts = await harness.repos.customers.listContacts(customer!.id);
    const job = await createJob(harness.as(master), {
      customerId: customer!.id, siteId: sites[0]!.id, contactId: contacts[0]!.id, machineId: null, jobType: 'parts',
      priority: null, scheduledDate: null, scheduledEndDate: null, additionalTechnicianIds: [], orderNumber: '',
      referenceNumber: '', deliveryNote: '', faultDescription: '', primaryTechnicianId: null, courierCollection: false,
      dateReceived: null, repairItem: { partNumber: '', description: '', quantity: null }, quoteNumber: 'Q-PARTS-7',
    });
    expect(job.orderNumber).toBe('');
    expect(job.quoteNumber).toBe('Q-PARTS-7');
    const view = await loadJobView(harness.repos, job.jobNumber);
    const clock = { now: () => '2026-10-28T10:00:00.000Z' };
    const text = pdfPlainText((await renderJobCardPdf(view!, new SimulatedPdfService(clock), clock, new Map())).bytes);
    expect(text).toContain('Q-PARTS-7');
  });
});

describe('PARTS-03 / PARTS-04 / PARTS-05 — a priced job card AND a separate delivery note', () => {
  const pdfOf = async (job: Job) => {
    const view = await loadJobView(harness.repos, job.jobNumber);
    const clock = { now: () => '2026-10-28T10:00:00.000Z' };
    return pdfPlainText((await renderJobCardPdf(view!, new SimulatedPdfService(clock), clock, new Map())).bytes);
  };

  it('a courier collection keeps the job card priced, and the delivery note lists the goods with no price', async () => {
    let job = await workshopJob();
    job = await startCompletion(harness.as(sipho), job);
    job = await setCollectionMethod(harness.as(sipho), job, { courier: true, waybillNumber: 'DAW-4471' });

    const card = await pdfOf(job);
    for (const priced of ['PSU-77', 'Power supply board', 'R 150,00', 'R 300,00', 'Total']) expect(card, priced).toContain(priced);

    const before = await harness.repos.jobs.findById(job.id);
    const note = await generateDeliveryNote(harness.as(sipho), job);
    expect(note.fileName).toBe(`${job.jobNumber}-Delivery-Note.pdf`);
    const text = pdfPlainText(Buffer.from(note.base64, 'base64'));
    for (const expected of ['DELIVERY NOTE', job.jobNumber, 'PSU-77', 'Power supply board', 'A06B-6117', 'Spindle amplifier', 'DAW-4471', 'Total items', '3']) {
      expect(text, expected).toContain(expected);
    }
    for (const price of ['R 150,00', 'R 300,00', 'VAT', 'Subtotal']) expect(text, price).not.toContain(price);
    // No amount in rand anywhere on it.
    expect(text).not.toMatch(/R\s\d/u);
    // The job, and so its job card, is untouched; the production is on the trail.
    expect(await harness.repos.jobs.findById(job.id)).toEqual(before);
    expect((await events('delivery_note_generated')).length).toBe(1);
  });

  it('there is no delivery note without a courier collection, before completion, or on a site job', async () => {
    let job = await workshopJob();
    await expect(generateDeliveryNote(harness.as(sipho), job)).rejects.toMatchObject({ violations: [{ code: 'delivery_note_not_applicable' }] });
    job = await startCompletion(harness.as(sipho), job);
    job = await setCollectionMethod(harness.as(sipho), job, { courier: false, waybillNumber: '' });
    await expect(generateDeliveryNote(harness.as(sipho), job)).rejects.toMatchObject({ violations: [{ code: 'delivery_note_not_applicable' }] });
    const breakdown = await workshopJob({ jobType: 'breakdown' });
    await expect(generateDeliveryNote(harness.as(sipho), breakdown)).rejects.toMatchObject({ violations: [{ code: 'delivery_note_not_applicable' }] });
    // A non-courier collection's job card is priced too, as it always was.
    expect(await pdfOf(job)).toContain('R 300,00');
  });
});
