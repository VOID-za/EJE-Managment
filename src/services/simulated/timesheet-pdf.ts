import type { TimesheetDocument, TimesheetDocumentRow } from '@/application/timesheets';
import { formatCurrency, formatDateTime } from '@/lib/format';
import { formatDayAndDate } from '@/lib/timesheet-dates';
import { renderOnePageForm, type FormLayout, type FormRow } from './one-page-form';

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
 * two panels when a month is busy, and a refusal rather than a second page.
 */

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
  readonly layout: FormLayout;
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

  const rendered = renderOnePageForm({
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
    footer: `${doc.companyName} · Time Sheet · ${doc.technicianName} · ${doc.periodLabel} · Generated ${formatDateTime(options.generatedAt)}`,
  });
  return { fileName: doc.fileName, bytes: rendered.bytes, pageCount: rendered.pageCount, layout: rendered.layout };
};
