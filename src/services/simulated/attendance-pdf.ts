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

/** The month's count, in one sentence. Pure; what the PDF and the screen print. */
export const attendanceSummaryLine = (doc: Pick<AttendanceDocument, 'summary'>): string => {
  const { present, absent, byReason, notRecorded, weekdaysNotRecorded } = doc.summary;
  const reasons = byReason.length === 0 ? '' : ` (${byReason.map((entry) => `${entry.label} ${entry.count}`).join(', ')})`;
  return `Present ${present} · Absent ${absent}${reasons} · Not recorded ${notRecorded}${weekdaysNotRecorded > 0 ? ` (${weekdaysNotRecorded} weekday${weekdaysNotRecorded === 1 ? '' : 's'})` : ''}`;
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
