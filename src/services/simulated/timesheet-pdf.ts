import type { TimesheetDocument, TimesheetDocumentRow } from '@/application/timesheets';
import { formatCurrency, formatDateTime } from '@/lib/format';
import { PdfBuilder, textWidth } from '@/lib/pdf/writer';
import { formatDayAndDate } from '@/lib/timesheet-dates';
import {
  BAND,
  BODY,
  CONTENT_WIDTH,
  GAP,
  INK,
  MARGIN,
  MUTED,
  RIGHT,
  RULE,
  RULE_SOFT,
  Sheet,
  SIZE,
  TRACK_TITLE,
} from './pdf-sheet';

/**
 * THE TIMESHEET PDF LAYOUT. PDF-01 … PDF-04 (the real-world reviewer,
 * 28 October 2026).
 *
 * Heading "Time Sheet", the Technician Name and the Month; one table with the
 * columns Date, Customer, OT, DT, Callout, Km, Hm; a Comments box at the bottom
 * holding the one comment for the whole timesheet. The date carries its day of
 * the week. Printed from `TimesheetDocument` and nothing else, so Preview,
 * Print and the office's copy of a submitted month are the same document.
 *
 * Km is the line's internal and customer kilometres, "internal / customer",
 * because the reviewer asked for both and for one Km column. Hm is printed as
 * the reviewer drew it and left EMPTY: nothing on the timesheet defines what it
 * holds (the open question is in docs/reviewer-feedback-2026-10-28.md), and
 * inventing a value would put a number on a payroll document nobody typed.
 *
 * The totals row adds up the columns the sheet already totals on screen; no new
 * calculation is introduced. Values written before 28 October 2026 that the
 * Layout no longer has a column for — NT and call-out counts — are stated under
 * the table, never dropped and never moved into another column.
 */

const COLUMNS = (() => {
  const widths = { date: 78, customer: 150, ot: 40, dt: 40, callout: 78, km: 82, hm: 47 };
  let x = MARGIN;
  const at = {} as Record<keyof typeof widths, { readonly x: number; readonly width: number }>;
  for (const key of Object.keys(widths) as (keyof typeof widths)[]) {
    at[key] = { x, width: widths[key] };
    x += widths[key];
  }
  return at;
})();

const ROW = 13;
const CELL = SIZE.small + 0.5;

const fit = (value: string, width: number, size: number): string => {
  if (textWidth(value, size) <= width - 4) return value;
  let cut = value;
  while (cut.length > 1 && textWidth(`${cut}…`, size) > width - 4) cut = cut.slice(0, -1);
  return `${cut}…`;
};

const hours = (value: number | null): string => (value === null ? '' : value.toFixed(2));
const km = (row: TimesheetDocumentRow): string =>
  row.internalKm === null || row.customerKm === null ? '' : `${row.internalKm.toFixed(1)} / ${row.customerKm.toFixed(1)}`;
const callout = (row: TimesheetDocumentRow): string =>
  row.calloutAmount === null || row.calloutAmount === 0
    ? row.recorded ? '—' : ''
    : `${formatCurrency(row.calloutAmount)}${row.calloutShared ? ' (sh)' : ''}`;

const tableHeader = (sheet: Sheet): void => {
  sheet.need(ROW * 2);
  sheet.pdf.rect(MARGIN, sheet.cursor - 4, CONTENT_WIDTH, ROW + 1, BAND);
  const label = (key: keyof typeof COLUMNS, text: string, right = false) => {
    const column = COLUMNS[key];
    const x = right ? column.x + column.width - 3 - textWidth(text, CELL, 'bold') : column.x + 3;
    sheet.pdf.text(x, sheet.cursor, text, { font: 'bold', size: CELL, colour: INK });
  };
  label('date', 'Date');
  label('customer', 'Customer');
  label('ot', 'OT', true);
  label('dt', 'DT', true);
  label('callout', 'Callout', true);
  label('km', 'Km (int / cust)', true);
  label('hm', 'Hm', true);
  sheet.move(ROW);
  sheet.rule(RULE, 0.6);
  sheet.move(3);
};

export interface TimesheetPdfOptions {
  readonly companyName: string;
  readonly generatedAt: string;
}

export interface RenderedTimesheet {
  readonly fileName: string;
  readonly bytes: Uint8Array;
  readonly pageCount: number;
}

export const timesheetFileName = (doc: Pick<TimesheetDocument, 'technicianName' | 'month'>): string =>
  `Time-Sheet-${doc.technicianName.replace(/[^A-Za-z0-9]+/gu, '-')}-${doc.month}.pdf`;

export const renderTimesheetPdf = (doc: TimesheetDocument, options: TimesheetPdfOptions): RenderedTimesheet => {
  const sheet = new Sheet();

  // Heading.
  sheet.text(MARGIN, options.companyName, { font: 'bold', size: SIZE.companyName, colour: INK });
  sheet.pdf.text(RIGHT - textWidth('TIME SHEET', SIZE.jobNumber, 'bold') - TRACK_TITLE * 10, sheet.cursor, 'TIME SHEET', {
    font: 'bold',
    size: SIZE.jobNumber,
    colour: INK,
    tracking: TRACK_TITLE,
  });
  sheet.move(GAP.sectionLarge);
  sheet.text(MARGIN, 'Time Sheet', { font: 'bold', size: SIZE.total, colour: INK });
  sheet.move(GAP.line + 4);
  const labelled = (label: string, value: string) => {
    sheet.text(MARGIN, label, { size: SIZE.body, colour: MUTED });
    sheet.text(MARGIN + 100, value, { font: 'bold', size: SIZE.body, colour: INK });
    sheet.move(GAP.line);
  };
  labelled('Technician Name', doc.technicianName);
  labelled('Month', doc.monthLabel);
  labelled(
    'Status',
    doc.submittedAt === null
      ? 'Draft — not sent to the office'
      : `Sent to the office ${formatDateTime(doc.submittedAt)}${doc.submittedByName === null ? '' : ` by ${doc.submittedByName}`}`,
  );
  sheet.move(GAP.tight);

  // The table.
  tableHeader(sheet);
  let lastDate = '';
  for (const row of doc.rows) {
    if (sheet.wouldOverflow(ROW + 4)) {
      sheet.need(ROW * 3);
      tableHeader(sheet);
      lastDate = '';
    }
    const colour = row.recorded ? BODY : MUTED;
    const cell = (key: keyof typeof COLUMNS, text: string, right = false) => {
      if (text.length === 0) return;
      const column = COLUMNS[key];
      const value = fit(text, column.width, CELL);
      const x = right ? column.x + column.width - 3 - textWidth(value, CELL) : column.x + 3;
      sheet.pdf.text(x, sheet.cursor, value, { size: CELL, colour });
    };
    cell('date', row.date === lastDate ? '' : formatDayAndDate(row.date));
    cell('customer', row.customer);
    cell('ot', hours(row.overtimeHours), true);
    cell('dt', hours(row.doubleHours), true);
    cell('callout', callout(row), true);
    cell('km', km(row), true);
    lastDate = row.date;
    sheet.move(ROW - 3);
    sheet.rule(RULE_SOFT, 0.4);
    sheet.move(3);
  }

  // Totals: the sums the sheet already shows; nothing new is calculated.
  sheet.need(ROW + 6);
  sheet.rule(RULE, 0.8);
  sheet.move(ROW - 2);
  const total = (key: keyof typeof COLUMNS, text: string) => {
    const column = COLUMNS[key];
    sheet.pdf.text(column.x + column.width - 3 - textWidth(text, CELL, 'bold'), sheet.cursor, text, {
      font: 'bold',
      size: CELL,
      colour: INK,
    });
  };
  sheet.pdf.text(COLUMNS.customer.x + 3, sheet.cursor, 'Totals', { font: 'bold', size: CELL, colour: INK });
  total('ot', doc.totals.overtimeHours.toFixed(2));
  total('dt', doc.totals.doubleHours.toFixed(2));
  total('callout', formatCurrency(doc.totals.calloutAmount));
  total('km', `${doc.totals.internalKm.toFixed(1)} / ${doc.totals.customerKm.toFixed(1)}`);
  sheet.move(GAP.line + 4);

  // History the Layout has no column for — stated, not dropped.
  const notes: string[] = [];
  if (doc.rows.some((row) => row.calloutShared)) notes.push('(sh) — a call-out shared with other jobs; the amount is as entered, not divided.');
  if (doc.totals.historicalNormalHours > 0) {
    notes.push(`NT entered before 28 October 2026 (no longer recorded): ${doc.totals.historicalNormalHours.toFixed(2)} hours, kept as entered.`);
  }
  if (doc.totals.historicalCallouts > 0) {
    notes.push(`Call-outs counted before 28 October 2026 (now an amount): ${doc.totals.historicalCallouts}, kept as entered.`);
  }
  for (const absence of doc.absences) notes.push(`${formatDayAndDate(absence.date)}: ${absence.reason}.`);
  for (const note of notes) sheet.paragraph(note, { size: SIZE.small, colour: MUTED });

  // The Comments box.
  sheet.move(GAP.tight);
  const lines = doc.comment.trim().length === 0 ? [] : PdfBuilder.wrap(doc.comment.trim(), CONTENT_WIDTH - 16, SIZE.body);
  const boxHeight = Math.max(70, 24 + lines.length * (SIZE.body * 1.45));
  sheet.need(boxHeight + 6);
  const top = sheet.cursor + 4;
  sheet.pdf.line(MARGIN, top, RIGHT, top, 0.8, RULE);
  sheet.pdf.line(MARGIN, top - boxHeight, RIGHT, top - boxHeight, 0.8, RULE);
  sheet.pdf.line(MARGIN, top, MARGIN, top - boxHeight, 0.8, RULE);
  sheet.pdf.line(RIGHT, top, RIGHT, top - boxHeight, 0.8, RULE);
  sheet.move(10);
  sheet.text(MARGIN + 8, 'Comments', { font: 'bold', size: SIZE.small, colour: MUTED });
  sheet.move(GAP.line + 2);
  for (const line of lines) {
    sheet.text(MARGIN + 8, line, { size: SIZE.body, colour: BODY });
    sheet.move(SIZE.body * 1.45);
  }

  // Footer on every page.
  const pages = sheet.pdf.pageCount;
  for (let index = 0; index < pages; index += 1) {
    sheet.pdf.selectPage(index);
    const footer = `${options.companyName} · Time Sheet · ${doc.technicianName} · ${doc.monthLabel} · Generated ${formatDateTime(options.generatedAt)}`;
    sheet.pdf.text(MARGIN, MARGIN - 12, fit(footer, CONTENT_WIDTH - 70, SIZE.tiny), { size: SIZE.tiny, colour: MUTED });
    const page = `Page ${index + 1} of ${pages}`;
    sheet.pdf.text(RIGHT - textWidth(page, SIZE.tiny), MARGIN - 12, page, { size: SIZE.tiny, colour: MUTED });
  }

  return { fileName: timesheetFileName(doc), bytes: sheet.pdf.toBytes(), pageCount: pages };
};
