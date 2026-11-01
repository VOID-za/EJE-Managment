import type { AttendanceDocument } from '@/application/attendance-document';
import { formatDateTime } from '@/lib/format';
import { formatDayAndDate } from '@/lib/timesheet-dates';
import { renderOnePageForm, type FormLayout } from './one-page-form';

/**
 * THE MONTHLY ATTENDANCE PDF. PAY-01, PAY-04 (29 October 2026).
 *
 * Heading "Attendance", the Technician Name, the Month and the status; one row
 * per day — Date | Attendance | Absence reason | Note — and the month's count
 * under it. EXACTLY ONE A4 PAGE, laid out by the same renderer as the
 * timesheet: every note wraps, nothing is cut, and a month that could not fit
 * legibly is refused rather than spilt onto a second page.
 *
 * Printed from `AttendanceDocument` and nothing else, so the preview, print,
 * download and the Finance package are the same document.
 */

export const ATTENDANCE_PDF_COLUMNS = [
  { key: 'date', header: 'Date', weight: 82, align: 'left' },
  { key: 'status', header: 'Attendance', weight: 70, align: 'left' },
  { key: 'reason', header: 'Absence reason', weight: 110, align: 'left' },
  { key: 'note', header: 'Note', weight: 253, align: 'left' },
] as const;

export interface RenderedAttendance {
  readonly fileName: string;
  readonly bytes: Uint8Array;
  readonly pageCount: number;
  readonly layout: FormLayout;
}

/**
 * The month's count, in one sentence. Pure; what the PDF and the screen print.
 *
 * RECORDED DAYS ONLY (PDF-UNREC-1, the tester, 1 November 2026): the form lists
 * and counts the days somebody recorded; a day nobody recorded is neither a
 * row nor a number on it, and the sentence says so, so a missing day is not
 * read as an absence.
 */
export const attendanceSummaryLine = (doc: Pick<AttendanceDocument, 'summary' | 'rows'>): string => {
  const { present, absent, byReason } = doc.summary;
  if (doc.rows.length === 0) return 'No day of this month has been recorded.';
  const reasons = byReason.length === 0 ? '' : ` (${byReason.map((entry) => `${entry.label} ${entry.count}`).join(', ')})`;
  return `Present ${present} · Absent ${absent}${reasons} · Only recorded days are listed; a day not recorded is left out.`;
};

export const renderAttendancePdf = (doc: AttendanceDocument, options: { readonly generatedAt: string }): RenderedAttendance => {
  const rendered = renderOnePageForm({
    companyName: doc.companyName,
    title: 'ATTENDANCE',
    fields: [
      ['Technician Name', doc.technicianName],
      ['Month', doc.monthLabel],
      [
        'Status',
        doc.submittedAt === null
          ? 'Draft — not submitted to the office'
          : `Submitted to the office ${formatDateTime(doc.submittedAt)}${doc.submittedByName === null ? '' : ` by ${doc.submittedByName}`}`,
      ],
      ['Version', doc.versionLabel],
    ],
    columns: ATTENDANCE_PDF_COLUMNS.map((column) => ({ ...column })),
    rows: doc.rows.map((row) => ({
      cells: { date: formatDayAndDate(row.date), status: row.status, reason: row.reason, note: row.note },
      muted: !row.recorded,
    })),
    notes: [attendanceSummaryLine(doc)],
    footer: `${doc.companyName} · Attendance · ${doc.technicianName} · ${doc.monthLabel} · Generated ${formatDateTime(options.generatedAt)}`,
  });
  return { fileName: doc.fileName, bytes: rendered.bytes, pageCount: rendered.pageCount, layout: rendered.layout };
};
