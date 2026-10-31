import type { AttendanceDocument } from '@/application/attendance-document';
import { formatDateTime } from '@/lib/format';
import { formatDayAndDate } from '@/lib/timesheet-dates';
import { ATTENDANCE_PDF_COLUMNS, attendanceSummaryLine } from '@/services/simulated/attendance-pdf';

/**
 * THE MONTHLY ATTENDANCE FORM, DRAWN BY THE BROWSER. PAY-01.
 *
 * The same `AttendanceDocument` the one-page PDF is rendered from, through the
 * same columns and summary — so the preview, the printout, the download and
 * the Finance package are the same document. Shown where the browser cannot
 * display a PDF (the tablets) and printed from there.
 */
export const AttendanceDocumentView = ({ document }: { readonly document: AttendanceDocument }) => (
  <article
    className="eje-document mx-auto max-w-[210mm] bg-white p-6 text-[12px] text-steel-900 shadow-sm"
    data-testid="attendance-document"
  >
    <header className="flex items-start justify-between gap-4">
      <p className="text-base font-bold">{document.companyName}</p>
      <p className="text-xl font-bold tracking-[0.15em]">ATTENDANCE</p>
    </header>
    <dl className="mt-4 grid grid-cols-[8rem_1fr] gap-y-1">
      <dt className="text-steel-500">Technician Name</dt>
      <dd className="font-semibold" data-testid="attendance-document-technician">{document.technicianName}</dd>
      <dt className="text-steel-500">Month</dt>
      <dd className="font-semibold" data-testid="attendance-document-month">{document.monthLabel}</dd>
      <dt className="text-steel-500">Status</dt>
      <dd className="font-semibold">
        {document.submittedAt === null
          ? 'Draft — not submitted to the office'
          : `Submitted to the office ${formatDateTime(document.submittedAt)}${document.submittedByName === null ? '' : ` by ${document.submittedByName}`}`}
      </dd>
      <dt className="text-steel-500">Version</dt>
      <dd className={document.inForce ? 'font-semibold' : 'font-semibold text-signal-600'} data-testid="attendance-document-version">
        {document.versionLabel}
      </dd>
    </dl>
    <table className="mt-4 w-full border-collapse text-xs">
      <thead>
        <tr className="bg-steel-50 text-left" data-testid="attendance-document-header">
          {ATTENDANCE_PDF_COLUMNS.map((column) => (
            <th key={column.key} className="px-1.5 py-1">{column.header}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {document.rows.map((row) => (
          <tr key={row.date} className={`border-t border-steel-100 ${row.recorded ? '' : 'text-steel-400'}`} data-testid="attendance-document-row">
            <td className="px-1.5 py-0.5 whitespace-nowrap">{formatDayAndDate(row.date)}</td>
            <td className="px-1.5 py-0.5">{row.status}</td>
            <td className="px-1.5 py-0.5">{row.reason}</td>
            <td className="px-1.5 py-0.5 whitespace-pre-wrap">{row.note}</td>
          </tr>
        ))}
      </tbody>
    </table>
    <p className="mt-3 text-xs text-steel-500" data-testid="attendance-document-summary">{attendanceSummaryLine(document)}</p>
  </article>
);
