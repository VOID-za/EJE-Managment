import { describe, expect, it } from 'vitest';
import type { TimesheetDocument, TimesheetDocumentRow } from '@/application/timesheets';
import type { AttendanceDocument } from '@/application/attendance-document';
import { buildAttendanceRows } from '@/application/attendance-document';
import { pdfPageTexts } from '@/lib/pdf/inspect';
import { renderTimesheetPdf } from './timesheet-pdf';
import { renderAttendancePdf } from './attendance-pdf';
import { MIN_BODY_PT, OnePageOverflow, renderOnePageForm } from './one-page-form';

/**
 * PAY-04: EVERY TIMESHEET AND ATTENDANCE PDF IS EXACTLY ONE PAGE — proved on
 * the PDF bytes (the pages read back out of the file, not the builder's own
 * count), for realistic and worst-case months, with every row's content found
 * in the page, nothing drawn below the footer line and the type never below
 * the legible floor. And a form that could not fit is refused, never spilt.
 */

const days = (month: string, count: number): string[] =>
  Array.from({ length: count }, (_, index) => `${month}-${String(index + 1).padStart(2, '0')}`);

const LONG = 'Vaal Triangle Steel and Engineering Works (Pty) Ltd — Vanderbijlpark Plant 3';

const row = (date: string, index: number, customer: string): TimesheetDocumentRow => ({
  date,
  weekday: 'Mon',
  customer,
  recorded: true,
  overtimeHours: 2.25 + (index % 3),
  doubleHours: index % 2 === 0 ? 1.5 : 0,
  calloutAmount: index % 4 === 0 ? 123456 : 0,
  calloutShared: index % 8 === 0,
  internalKm: 123.4,
  customerKm: 987.6,
  historicalNormalHours: 0,
  historicalCallouts: 0,
});

const timesheet = (rows: TimesheetDocumentRow[], comment: string, absences = 0): TimesheetDocument => ({
  companyName: 'EJE Industrial Services (Pty) Ltd',
  technicianName: 'Johannes Christiaan van der Merwe-Mostert',
  fileName: 'JC TIMESHEET OCT.pdf',
  from: '2026-10-01',
  to: '2026-10-31',
  periodLabel: 'Thu 1 Oct 2026 – Sat 31 Oct 2026',
  rows,
  comment,
  totals: { overtimeHours: 99.75, doubleHours: 23.5, calloutAmount: 9876500, internalKm: 3825.4, customerKm: 30615.6, historicalNormalHours: 7.5, historicalCallouts: 2 },
  submittedAt: '2026-10-31T15:00:00.000Z',
  submittedByName: 'Johannes Christiaan van der Merwe-Mostert',
  versionLabel: 'Correction 2, accepted 2026-11-02 by Christene van Niekerk',
  inForce: true,
  absences: days('2026-10', absences).map((date) => ({ date, reason: 'Family Responsibility' })),
});

const pages = (bytes: Uint8Array) => pdfPageTexts(bytes);
const flat = (text: string) => text.replace(/\s+/gu, ' ');

describe('PAY-04 — the timesheet PDF is exactly one page', () => {
  const cases: [string, TimesheetDocumentRow[], string, number][] = [
    ['a realistic month: one line a day', days('2026-10', 31).map((date, i) => row(date, i, 'ABC Engineering')), 'Normal month.', 0],
    // Worst cases a real month can produce, each pushed on one axis at a time
    // with everything else heavy too.
    ['a busy month: three lines every day, two with 80-character customer names, a 500-character comment, four absences', days('2026-10', 31).flatMap((date, i) => [row(date, i, LONG), row(date, i + 1, `${LONG} B`), row(date, i + 2, 'Workshop')]), 'A long comment about the month. '.repeat(16).slice(0, 500), 4],
    ['the longest comment allowed (2 000 characters), two long lines a day, every weekday of absences named', days('2026-10', 31).flatMap((date, i) => [row(date, i, LONG), row(date, i + 1, 'Workshop')]), 'Comment text that goes on. '.repeat(80).slice(0, 2000), 22],
    ['a very busy month: five lines every day (155 rows) — two panels', days('2026-10', 31).flatMap((date, i) => Array.from({ length: 5 }, (_, k) => row(date, i + k, `Kruger Engineering ${k}`))), 'Five jobs a day.', 0],
    ['a 92-day period, two lines a day (184 rows)', [...days('2026-08', 31), ...days('2026-09', 30), ...days('2026-10', 31)].flatMap((date, i) => [row(date, i, 'Kruger Engineering Midrand'), row(date, i + 1, 'Workshop')]), 'Quarter.', 0],
  ];
  for (const [name, rows, comment, absences] of cases) {
    it(name, () => {
      const rendered = renderTimesheetPdf(timesheet(rows, comment, absences), { generatedAt: '2026-10-31T16:00:00.000Z' });
      const read = pages(rendered.bytes);
      expect(rendered.pageCount).toBe(1);
      expect(read).toHaveLength(1);
      expect(rendered.layout.bodyPt).toBeGreaterThanOrEqual(MIN_BODY_PT);
      expect(rendered.layout.lowestBaseline).toBeGreaterThanOrEqual(rendered.layout.footerTop);
      const text = flat(read[0]!);
      for (const header of ['Date', 'Customer', 'OT', 'D/T', 'Callout', 'Int Km', 'Cust Km', 'Totals', 'Comments']) expect(text).toContain(header);
      expect(text).not.toMatch(/\bHm\b/u);
      // Every row is on the page: each line's OT value is printed once per row.
      const otPrinted = (text.match(/\b[2-4]\.25\b/gu) ?? []).length;
      expect(otPrinted).toBeGreaterThanOrEqual(rows.length);
      // A long customer name is wrapped, not cut: every word of it is on the page.
      if (rows.some((r) => r.customer === LONG)) {
        for (const word of ['Vanderbijlpark', 'Plant', 'Works', '(Pty)']) expect(text).toContain(word);
      }
      expect(text).not.toContain('…');
      expect(text).toContain('Page 1 of 1');
    });
  }

  it('reports two panels only when one cannot hold the month', () => {
    const light = renderTimesheetPdf(timesheet(days('2026-10', 31).map((d, i) => row(d, i, 'ABC')), ''), { generatedAt: '2026-10-31T16:00:00.000Z' });
    expect(light.layout.panels).toBe(1);
    expect(light.layout.scale).toBe(1);
  });

  it('refuses a form that cannot be printed legibly on one page, instead of a second page or dropped rows', () => {
    const absurd = days('2026-10', 31).flatMap((date, i) => Array.from({ length: 30 }, (_, k) => row(date, i + k, `${LONG} ${k}`)));
    expect(() => renderTimesheetPdf(timesheet(absurd, ''), { generatedAt: '2026-10-31T16:00:00.000Z' })).toThrow(OnePageOverflow);
    // Every axis at its maximum at once — three 80-character lines every day,
    // the longest comment, absent every day as well — is more than one legible
    // page holds: refused, said so, never trimmed.
    const everything = days('2026-10', 31).flatMap((date, i) => [row(date, i, LONG), row(date, i + 1, `${LONG} B`), row(date, i + 2, 'Workshop')]);
    expect(() => renderTimesheetPdf(timesheet(everything, 'x'.repeat(2000), 31), { generatedAt: '2026-10-31T16:00:00.000Z' })).toThrow(OnePageOverflow);
  });
});

const attendance = (notes: string): AttendanceDocument => {
  const month = days('2026-10', 31).map((date, i) => ({
    date,
    status: i % 5 === 4 ? ('absent' as const) : i % 7 === 6 ? null : ('present' as const),
    absenceReason: i % 5 === 4 ? (['leave', 'sick_leave', 'family_responsibility', 'iod'] as const)[i % 4]! : null,
    note: notes,
  }));
  return {
    companyName: 'EJE Industrial Services (Pty) Ltd',
    technicianName: 'Johannes Christiaan van der Merwe-Mostert',
    fileName: 'JC ATTEN OCTOBER.pdf',
    month: '2026-10',
    monthLabel: 'October 2026',
    ...buildAttendanceRows(month, '2026-10-31'),
    submittedAt: '2026-10-31T15:00:00.000Z',
    submittedByName: 'Johannes Christiaan van der Merwe-Mostert',
    versionLabel: 'Corrected by the office after submission (2 days: Mon 5 Oct 2026, Tue 6 Oct 2026)',
    inForce: true,
    changedAfterSubmission: ['2026-10-05', '2026-10-06'],
  };
};

describe('PAY-04 — the attendance PDF is exactly one page', () => {
  for (const [name, note] of [
    ['a realistic month', 'On site'],
    ['a heavy month: a 250-character note on every one of 31 days', `Clinic visit ${'with a very long explanation '.repeat(10)}`.slice(0, 250)],
    ['a very heavy month: a 350-character note on every one of 31 days', `Clinic visit ${'with a very long explanation '.repeat(14)}`.slice(0, 350)],
  ] as const) {
    it(name, () => {
      const doc = attendance(note);
      const rendered = renderAttendancePdf(doc, { generatedAt: '2026-10-31T16:00:00.000Z' });
      const read = pages(rendered.bytes);
      expect(rendered.pageCount).toBe(1);
      expect(read).toHaveLength(1);
      expect(rendered.layout.bodyPt).toBeGreaterThanOrEqual(MIN_BODY_PT);
      expect(rendered.layout.lowestBaseline).toBeGreaterThanOrEqual(rendered.layout.footerTop);
      const text = flat(read[0]!);
      for (const header of ['ATTENDANCE', 'Technician Name', 'Month', 'October 2026', 'Date', 'Attendance', 'Absence reason', 'Note']) expect(text).toContain(header);
      for (const label of ['Leave', 'Sick Leave', 'Family Responsibility', 'IOD (Injury on Duty)', 'NOT RECORDED']) expect(text).toContain(label);
      // Every day is on the page.
      expect((text.match(/Oct 2026/gu) ?? []).length).toBeGreaterThanOrEqual(31);
      expect(text).toContain('Present');
      expect(text).toContain('Corrected by the office after submission');
      expect(text).not.toContain('…');
    });
  }
});

describe('PAY-04 — what cannot fit on one page is refused, not cut', () => {
  it('a 500-character note on EVERY day of the month (15 500 characters) is more than one legible page holds', () => {
    expect(() => renderAttendancePdf(attendance('n'.repeat(10) + ' word'.repeat(98)), { generatedAt: '2026-10-31T16:00:00.000Z' })).toThrow(OnePageOverflow);
  });
});

describe('the one-page renderer itself', () => {
  it('never draws a second page, whatever it is given that fits', () => {
    const rendered = renderOnePageForm({
      companyName: 'X', title: 'T', fields: [['A', 'B']],
      columns: [{ key: 'a', header: 'A', weight: 1, align: 'left' }],
      rows: Array.from({ length: 150 }, (_, i) => ({ cells: { a: `row ${i}` } })),
      notes: [], footer: 'f',
    });
    expect(rendered.pageCount).toBe(1);
    expect(pdfPageTexts(rendered.bytes)).toHaveLength(1);
    expect(flat(pdfPageTexts(rendered.bytes)[0]!)).toContain('row 149');
  });
});
