import type { TimesheetDocument, TimesheetDocumentRow } from '@/application/timesheets';
import { formatCurrency, formatDateTime } from '@/lib/format';
import { formatDayAndDate } from '@/lib/timesheet-dates';
import { PdfBuilder, textWidth } from '@/lib/pdf/writer';
import { OnePageOverflow, renderOnePageForm, type FormLayout, type FormRow } from './one-page-form';
import { BAND, BODY, CONTENT_WIDTH, GAP, INK, MARGIN, MUTED, RIGHT, RULE, RULE_SOFT, Sheet, SIZE, TRACK_TITLE } from './pdf-sheet';

/**
 * THE TIMESHEET PDF LAYOUT. PDF-01 … PDF-04 (the real-world reviewer, and the
 * owner's decisions of 28 October 2026); ONE PAGE, ALWAYS (PAY-04, 29 October).
 *
 * Heading "Time Sheet", the Technician Name and the Period (From – To); one
 * table with EXACTLY these columns, in this order:
 *
 *   Date | Customer | OT | D/T | Callout | Int Km | Cust Km
 *
 * and a Comments box holding the one comment for the period. The date carries
 * its day of the week. There is no Hm column — it was a mistake in an earlier
 * summary, not a requested field — and no NT column.
 *
 * Printed from `TimesheetDocument` and nothing else, so Preview, Print, the
 * download and the Finance package are the same document. The totals add up
 * the columns the sheet already totals on screen; nothing new is calculated.
 * Values written before 28 October 2026 that the Layout has no column for — NT
 * and call-out counts — are stated under the table, never dropped.
 *
 * The page is laid out by `renderOnePageForm`: the whole period on ONE A4
 * page, every cell wrapped (a long customer name is never cut), smaller type or
 * two panels when a month is busy.
 *
 * MORE PAGES WHEN IT DOES NOT FIT READABLY (TS-PAPER-6, 4 November 2026). A pay
 * period may be any length, so one page cannot always hold it: a timesheet that
 * would need type smaller than `READABLE_BODY_PT` on one page — or not fit at
 * all — is printed on as many pages as it needs, at a fixed readable size, with
 * the table's headings on every page, a day's lines kept together where they
 * fit, Page X of Y, and the totals, notes and comments after the last line.
 * The totals are the document's own (every line of the period), so they are
 * the same however the lines fall across pages. Timesheets only: every other
 * payroll form stays one page.
 */

/** The smallest body type a one-page timesheet may use; below it the timesheet goes onto more pages. */
export const READABLE_BODY_PT = 7;
/** The multi-page layout's fixed type size and line height. */
const MULTI_BODY_PT = 8;
const MULTI_LINE = 11;

/** The columns, in order, with their relative widths: the one definition the PDF and the screen use. */
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

/**
 * PDF-UNREC-1 (the tester, 1 November 2026): only days with a recorded line
 * are printed. Said under the table — on the PDF and the screen alike — so a
 * day that is not there is not read as a day off or as zero hours.
 */
export const timesheetRecordedOnlyNote = (doc: Pick<TimesheetDocument, 'rows' | 'from' | 'to'>): string | null => {
  if (doc.rows.length === 0) return 'No day in this period has a recorded line.';
  const days = (Date.parse(`${doc.to}T00:00:00Z`) - Date.parse(`${doc.from}T00:00:00Z`)) / 86_400_000 + 1;
  // Every day recorded: nothing is left out, and the line would only cost a busy month its room.
  if (new Set(doc.rows.map((row) => row.date)).size >= days) return null;
  return 'Only days with a recorded line are listed; a day not recorded is left out.';
};

export interface TimesheetPdfOptions {
  readonly generatedAt: string;
}

export interface RenderedTimesheet {
  readonly fileName: string;
  readonly bytes: Uint8Array;
  readonly pageCount: number;
  /** The one-page layout when it fits readably; null when the timesheet runs to several pages. */
  readonly layout: FormLayout | null;
}

export const renderTimesheetPdf = (doc: TimesheetDocument, options: TimesheetPdfOptions): RenderedTimesheet => {
  let lastDate = '';
  // A period may be any length; past ~11 months a day without its year could be read twice.
  const yearless = Date.parse(`${doc.to}T00:00:00Z`) - Date.parse(`${doc.from}T00:00:00Z`) < 330 * 86_400_000;
  const rows: FormRow[] = doc.rows.map((row) => {
    const showDate = row.date !== lastDate;
    lastDate = row.date;
    const cells = timesheetPdfCells(row, showDate);
    // In two panels the date drops its year — the Period line above gives it —
    // unless the period is long enough for a day to be ambiguous without it (TS-PAPER).
    return { cells, compact: { date: yearless ? cells.date.replace(/ \d{4}$/u, '') : cells.date }, muted: !row.recorded, groupStart: showDate };
  });

  const recordedOnly = timesheetRecordedOnlyNote(doc);
  const notes: string[] = recordedOnly === null ? [] : [recordedOnly];
  if (doc.rows.some((row) => row.calloutShared)) {
    notes.push('(sh) — a shared call-out: the amount is this technician’s own share, as they entered it; nothing is divided.');
  }
  if (doc.totals.historicalNormalHours > 0) {
    notes.push(`NT entered before 28 October 2026 (no longer recorded): ${doc.totals.historicalNormalHours.toFixed(2)} hours, kept as entered.`);
  }
  if (doc.totals.historicalCallouts > 0) {
    notes.push(`Call-outs counted before 28 October 2026 (now an amount): ${doc.totals.historicalCallouts}, kept as entered.`);
  }
  // The register's absences, for reference: one paragraph, every day named.
  if (doc.absences.length > 0) {
    notes.push(`Absent (attendance register): ${doc.absences.map((absence) => `${formatDayAndDate(absence.date)} — ${absence.reason}`).join('; ')}.`);
  }

  const fields: [string, string][] = [
    ['Technician Name', doc.technicianName],
    ['Period', doc.periodLabel],
    [
      'Status',
      doc.submittedAt === null
        ? 'Draft — not sent to the office'
        : `Sent to the office ${formatDateTime(doc.submittedAt)}${doc.submittedByName === null ? '' : ` by ${doc.submittedByName}`}`,
    ],
  ];
  // TS-16: which version of a sent timesheet this is, and whether it is in force.
  if (doc.versionLabel.length > 0) fields.push(['Version', doc.versionLabel]);

  const footer = `${doc.companyName} · Time Sheet · ${doc.technicianName} · ${doc.periodLabel} · Generated ${formatDateTime(options.generatedAt)}`;
  let onePage: ReturnType<typeof renderOnePageForm> | null = null;
  try {
    onePage = renderOnePageForm({
    companyName: doc.companyName,
    title: 'TIME SHEET',
    fields,
    columns: TIMESHEET_PDF_COLUMNS.map((column) => ({ key: column.key, header: column.header, weight: column.width, align: column.align })),
    rows,
    totals: {
      label: 'Totals',
      cells: {
        ot: doc.totals.overtimeHours.toFixed(2),
        dt: doc.totals.doubleHours.toFixed(2),
        callout: formatCurrency(doc.totals.calloutAmount),
        intKm: doc.totals.internalKm.toFixed(1),
        custKm: doc.totals.customerKm.toFixed(1),
      },
    },
    notes,
    comment: { title: 'Comments', text: doc.comment },
    footer,
    });
  } catch (cause) {
    if (!(cause instanceof OnePageOverflow)) throw cause;
  }
  if (onePage !== null && onePage.layout.bodyPt >= READABLE_BODY_PT - 1e-9) {
    return { fileName: doc.fileName, bytes: onePage.bytes, pageCount: onePage.pageCount, layout: onePage.layout };
  }
  const multi = renderMultiPageTimesheet(doc, fields, notes, footer);
  return { fileName: doc.fileName, bytes: multi.bytes, pageCount: multi.pageCount, layout: null };
};

/**
 * THE TIMESHEET ON SEVERAL PAGES, at a fixed readable size (TS-PAPER-6). Laid
 * out like the Delivery Note's goods table: the headings repeat on every page
 * the table reaches ("continued"), and the page number is written on every page
 * once the number of pages is known.
 */
const renderMultiPageTimesheet = (
  doc: TimesheetDocument,
  fields: readonly (readonly [string, string])[],
  notes: readonly string[],
  footer: string,
): { bytes: Uint8Array; pageCount: number } => {
  const sheet = new Sheet();
  sheet.text(MARGIN, doc.companyName, { font: 'bold', size: SIZE.companyName, colour: INK });
  const title = 'TIME SHEET';
  sheet.pdf.text(RIGHT - textWidth(title, SIZE.jobNumber, 'bold', TRACK_TITLE), sheet.cursor, title, { font: 'bold', size: SIZE.jobNumber, colour: INK, tracking: TRACK_TITLE });
  sheet.move(GAP.sectionLarge);
  for (const [label, value] of fields) {
    const lines = PdfBuilder.wrap(value, CONTENT_WIDTH - 110, SIZE.body);
    sheet.need(GAP.line * lines.length);
    sheet.text(MARGIN, label, { size: SIZE.body, colour: MUTED });
    for (const [index, line] of lines.entries()) {
      if (index > 0) sheet.move(GAP.line);
      sheet.text(MARGIN + 110, line, { size: SIZE.body, colour: BODY });
    }
    sheet.move(GAP.line);
  }
  sheet.move(GAP.tight);

  // The columns of the one-page layout, spread over the page's width.
  const weight = TIMESHEET_PDF_COLUMNS.reduce((sum, column) => sum + column.width, 0);
  const edges: number[] = [MARGIN];
  for (const column of TIMESHEET_PDF_COLUMNS) edges.push(edges.at(-1)! + (column.width / weight) * CONTENT_WIDTH);
  const cell = (index: number, value: string, options: { readonly bold?: boolean; readonly colour?: string; readonly size?: number } = {}) => {
    const column = TIMESHEET_PDF_COLUMNS[index]!;
    const style = { size: options.size ?? MULTI_BODY_PT, font: options.bold === true ? ('bold' as const) : ('regular' as const), colour: options.colour ?? INK };
    if (column.align === 'right') sheet.textRight(edges[index + 1]! - 3, value, style);
    else sheet.text(edges[index]! + 3, value, style);
  };
  const headings = (continued: boolean) => {
    if (continued) {
      sheet.text(MARGIN, 'Time Sheet (continued)', { font: 'bold', size: SIZE.small, colour: MUTED });
      sheet.move(GAP.line);
    }
    sheet.pdf.rect(MARGIN, sheet.cursor - 4, CONTENT_WIDTH, GAP.line + 2, BAND);
    TIMESHEET_PDF_COLUMNS.forEach((column, index) => cell(index, column.header, { bold: true, size: SIZE.small }));
    sheet.move(GAP.line + 2);
  };

  const customerWidth = edges[2]! - edges[1]! - 6;
  const heightOf = (row: TimesheetDocumentRow) => Math.max(1, PdfBuilder.wrap(row.customer, customerWidth, MULTI_BODY_PT).length) * MULTI_LINE + 4;
  const days: TimesheetDocumentRow[][] = [];
  for (const row of doc.rows) {
    const last = days.at(-1);
    if (last !== undefined && last[0]!.date === row.date) last.push(row);
    else days.push([row]);
  }
  sheet.need(GAP.line * 3);
  headings(false);
  if (doc.rows.length === 0) sheet.paragraph('No day in this period has a recorded line.', { size: MULTI_BODY_PT, colour: MUTED });
  for (const day of days) {
    // A day's lines together: when they do not fit what is left of the page, the day starts the next one.
    const dayHeight = day.reduce((sum, row) => sum + heightOf(row), 0);
    if (sheet.wouldOverflow(dayHeight)) {
      sheet.need(dayHeight);
      headings(true);
    }
    day.forEach((row, index) => {
      const height = heightOf(row);
      // A day longer than a whole page still breaks — between its lines, with the date said again.
      const broke = sheet.wouldOverflow(height);
      if (broke) {
        sheet.need(height);
        headings(true);
      }
      const cells = timesheetPdfCells(row, index === 0 || broke);
      cell(0, broke && index > 0 ? `${cells.date} (cont.)` : cells.date);
      cell(2, cells.ot);
      cell(3, cells.dt);
      cell(4, cells.callout);
      cell(5, cells.intKm);
      cell(6, cells.custKm);
      PdfBuilder.wrap(cells.customer, customerWidth, MULTI_BODY_PT).forEach((line, lineIndex) => {
        if (lineIndex > 0) sheet.move(MULTI_LINE);
        sheet.text(edges[1]! + 3, line, { size: MULTI_BODY_PT, colour: BODY });
      });
      sheet.move(MULTI_LINE - 3);
      sheet.rule(RULE_SOFT, 0.3);
      sheet.move(7);
    });
  }
  // The totals: every line of the period, whatever page it fell on.
  sheet.need(MULTI_LINE * 2 + 4);
  sheet.rule(RULE, 0.8);
  sheet.move(MULTI_LINE);
  cell(1, 'Totals', { bold: true });
  cell(2, doc.totals.overtimeHours.toFixed(2), { bold: true });
  cell(3, doc.totals.doubleHours.toFixed(2), { bold: true });
  cell(4, formatCurrency(doc.totals.calloutAmount), { bold: true });
  cell(5, doc.totals.internalKm.toFixed(1), { bold: true });
  cell(6, doc.totals.customerKm.toFixed(1), { bold: true });
  sheet.move(GAP.section);
  for (const note of notes) sheet.paragraph(note, { size: SIZE.small, colour: MUTED });
  sheet.move(GAP.tight);
  // "Comments", as the one-page layout's box is titled.
  sheet.need(GAP.line * 2);
  sheet.text(MARGIN, 'Comments', { font: 'bold', size: SIZE.body, colour: INK });
  sheet.move(GAP.line);
  sheet.paragraph(doc.comment.trim().length > 0 ? doc.comment : '—', { size: SIZE.body, colour: BODY });

  const pages = sheet.pdf.pageCount;
  for (let index = 0; index < pages; index += 1) {
    sheet.pdf.selectPage(index);
    const page = `Page ${index + 1} of ${pages}`;
    const room = CONTENT_WIDTH - textWidth(page, SIZE.tiny) - 12;
    sheet.pdf.text(MARGIN, MARGIN - 12, PdfBuilder.wrap(footer, room, SIZE.tiny)[0] ?? '', { size: SIZE.tiny, colour: MUTED });
    sheet.pdf.text(RIGHT - textWidth(page, SIZE.tiny), MARGIN - 12, page, { size: SIZE.tiny, colour: MUTED });
  }
  return { bytes: sheet.pdf.toBytes(), pageCount: pages };
};
