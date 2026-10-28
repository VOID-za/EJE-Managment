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
 * THE TIMESHEET PDF LAYOUT. PDF-01 … PDF-04 (the real-world reviewer, and the
 * owner's decisions of 28 October 2026).
 *
 * Heading "Time Sheet", the Technician Name and the chosen Period (From – To);
 * one table with EXACTLY these columns, in this order:
 *
 *   Date | Customer | OT | D/T | Callout | Int Km | Cust Km
 *
 * and a Comments box at the bottom holding the one comment for the period.
 * The date carries its day of the week. There is no Hm column — it was a
 * mistake in an earlier summary, not a requested field — and no NT column.
 *
 * Printed from `TimesheetDocument` and nothing else, so Preview, Print and the
 * office's copy of a sent period are the same document. The totals row adds
 * up the columns the sheet already totals on screen; nothing new is
 * calculated. Values written before 28 October 2026 that the Layout has no
 * column for — NT and call-out counts — are stated under the table, never
 * dropped and never moved into another column.
 */

/** The columns, in order, with their widths: the one definition both header and rows use. */
export const TIMESHEET_PDF_COLUMNS = [
  { key: 'date', header: 'Date', width: 82, align: 'left' },
  { key: 'customer', header: 'Customer', width: 165, align: 'left' },
  { key: 'ot', header: 'OT', width: 42, align: 'right' },
  { key: 'dt', header: 'D/T', width: 42, align: 'right' },
  { key: 'callout', header: 'Callout', width: 80, align: 'right' },
  { key: 'intKm', header: 'Int Km', width: 52, align: 'right' },
  { key: 'custKm', header: 'Cust Km', width: 52, align: 'right' },
] as const;

type ColumnKey = (typeof TIMESHEET_PDF_COLUMNS)[number]['key'];

const COLUMNS = (() => {
  let x = MARGIN;
  const at = {} as Record<ColumnKey, { readonly x: number; readonly width: number; readonly right: boolean }>;
  for (const column of TIMESHEET_PDF_COLUMNS) {
    at[column.key] = { x, width: column.width, right: column.align === 'right' };
    x += column.width;
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
const km = (value: number | null): string => (value === null ? '' : value.toFixed(1));
const callout = (row: TimesheetDocumentRow): string =>
  row.calloutAmount === null || row.calloutAmount === 0
    ? row.recorded ? '—' : ''
    : `${formatCurrency(row.calloutAmount)}${row.calloutShared ? ' (sh)' : ''}`;

/** A row's cell values, column by column. Pure, and what the tests read. */
export const timesheetPdfCells = (
  row: TimesheetDocumentRow,
  showDate: boolean,
): Readonly<Record<ColumnKey, string>> => ({
  date: showDate ? formatDayAndDate(row.date) : '',
  customer: row.customer,
  ot: hours(row.overtimeHours),
  dt: hours(row.doubleHours),
  callout: callout(row),
  intKm: km(row.internalKm),
  custKm: km(row.customerKm),
});

const tableHeader = (sheet: Sheet): void => {
  sheet.need(ROW * 2);
  sheet.pdf.rect(MARGIN, sheet.cursor - 4, CONTENT_WIDTH, ROW + 1, BAND);
  for (const column of TIMESHEET_PDF_COLUMNS) {
    const place = COLUMNS[column.key];
    const x = place.right
      ? place.x + place.width - 3 - textWidth(column.header, CELL, 'bold')
      : place.x + 3;
    sheet.pdf.text(x, sheet.cursor, column.header, { font: 'bold', size: CELL, colour: INK });
  }
  sheet.move(ROW);
  sheet.rule(RULE, 0.6);
  sheet.move(3);
};

export interface TimesheetPdfOptions {
  readonly generatedAt: string;
}

export interface RenderedTimesheet {
  readonly fileName: string;
  readonly bytes: Uint8Array;
  readonly pageCount: number;
}

export const timesheetFileName = (doc: Pick<TimesheetDocument, 'technicianName' | 'from' | 'to'>): string =>
  `Time-Sheet-${doc.technicianName.replace(/[^A-Za-z0-9]+/gu, '-')}-${doc.from}-to-${doc.to}.pdf`;

export const renderTimesheetPdf = (doc: TimesheetDocument, options: TimesheetPdfOptions): RenderedTimesheet => {
  const sheet = new Sheet();

  // Heading.
  sheet.text(MARGIN, doc.companyName, { font: 'bold', size: SIZE.companyName, colour: INK });
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
  labelled('Period', doc.periodLabel);
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
    const cells = timesheetPdfCells(row, row.date !== lastDate);
    for (const column of TIMESHEET_PDF_COLUMNS) {
      const text = cells[column.key];
      if (text.length === 0) continue;
      const place = COLUMNS[column.key];
      const value = fit(text, place.width, CELL);
      const x = place.right ? place.x + place.width - 3 - textWidth(value, CELL) : place.x + 3;
      sheet.pdf.text(x, sheet.cursor, value, { size: CELL, colour });
    }
    lastDate = row.date;
    sheet.move(ROW - 3);
    sheet.rule(RULE_SOFT, 0.4);
    sheet.move(3);
  }

  // Totals: the sums the sheet already shows; nothing new is calculated.
  sheet.need(ROW + 6);
  sheet.rule(RULE, 0.8);
  sheet.move(ROW - 2);
  const totals: Partial<Record<ColumnKey, string>> = {
    ot: doc.totals.overtimeHours.toFixed(2),
    dt: doc.totals.doubleHours.toFixed(2),
    callout: formatCurrency(doc.totals.calloutAmount),
    intKm: doc.totals.internalKm.toFixed(1),
    custKm: doc.totals.customerKm.toFixed(1),
  };
  sheet.pdf.text(COLUMNS.customer.x + 3, sheet.cursor, 'Totals', { font: 'bold', size: CELL, colour: INK });
  for (const [key, text] of Object.entries(totals) as [ColumnKey, string][]) {
    const place = COLUMNS[key];
    sheet.pdf.text(place.x + place.width - 3 - textWidth(text, CELL, 'bold'), sheet.cursor, text, {
      font: 'bold',
      size: CELL,
      colour: INK,
    });
  }
  sheet.move(GAP.line + 4);

  // History the Layout has no column for — stated, not dropped.
  const notes: string[] = [];
  if (doc.rows.some((row) => row.calloutShared)) {
    notes.push('(sh) — a shared call-out: the amount is this technician’s own share, as they entered it; nothing is divided.');
  }
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
    const footer = `${doc.companyName} · Time Sheet · ${doc.technicianName} · ${doc.periodLabel} · Generated ${formatDateTime(options.generatedAt)}`;
    sheet.pdf.text(MARGIN, MARGIN - 12, fit(footer, CONTENT_WIDTH - 70, SIZE.tiny), { size: SIZE.tiny, colour: MUTED });
    const page = `Page ${index + 1} of ${pages}`;
    sheet.pdf.text(RIGHT - textWidth(page, SIZE.tiny), MARGIN - 12, page, { size: SIZE.tiny, colour: MUTED });
  }

  return { fileName: timesheetFileName(doc), bytes: sheet.pdf.toBytes(), pageCount: pages };
};
