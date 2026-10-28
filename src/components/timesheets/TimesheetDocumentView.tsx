import type { TimesheetDocument, TimesheetDocumentRow } from '@/application/timesheets';
import { formatCurrency, formatDateTime } from '@/lib/format';
import { formatDayAndDate } from '@/lib/timesheet-dates';

const hours = (value: number | null): string => (value === null ? '' : value.toFixed(2));
const km = (row: TimesheetDocumentRow): string =>
  row.internalKm === null || row.customerKm === null ? '' : `${row.internalKm.toFixed(1)} / ${row.customerKm.toFixed(1)}`;
const callout = (row: TimesheetDocumentRow): string =>
  row.calloutAmount === null || row.calloutAmount === 0
    ? row.recorded ? '—' : ''
    : `${formatCurrency(row.calloutAmount)}${row.calloutShared ? ' (shared)' : ''}`;

/**
 * THE TIMESHEET PDF LAYOUT, DRAWN BY THE BROWSER. TS-11, TS-13, PDF-01.
 *
 * The same `TimesheetDocument` the PDF is rendered from, in the same order with
 * the same columns — Date, Customer, OT, DT, Callout, Km, Hm — and the Comments
 * box at the bottom. Shown where the browser cannot display a PDF (the tablets)
 * and printed from there. Hm is empty for the reason the PDF gives.
 */
export const TimesheetDocumentView = ({ document }: { readonly document: TimesheetDocument }) => (
  <article
    className="eje-document mx-auto max-w-[210mm] bg-white p-6 text-[12px] text-steel-900 shadow-sm"
    data-testid="timesheet-document"
  >
    <header className="flex items-start justify-between gap-4">
      <p className="text-base font-bold">{document.companyName}</p>
      <p className="text-xl font-bold tracking-[0.15em]">TIME SHEET</p>
    </header>
    <h2 className="mt-5 text-sm font-bold">Time Sheet</h2>
    <dl className="mt-2 grid grid-cols-[8rem_1fr] gap-y-1">
      <dt className="text-steel-500">Technician Name</dt>
      <dd className="font-semibold" data-testid="timesheet-document-technician">{document.technicianName}</dd>
      <dt className="text-steel-500">Month</dt>
      <dd className="font-semibold" data-testid="timesheet-document-month">{document.monthLabel}</dd>
      <dt className="text-steel-500">Status</dt>
      <dd className="font-semibold">
        {document.submittedAt === null
          ? 'Draft — not sent to the office'
          : `Sent to the office ${formatDateTime(document.submittedAt)}${document.submittedByName === null ? '' : ` by ${document.submittedByName}`}`}
      </dd>
    </dl>

    <table className="mt-4 w-full border-collapse text-[11px]">
      <thead>
        <tr className="bg-steel-50 text-left">
          <th className="px-1.5 py-1">Date</th>
          <th className="px-1.5 py-1">Customer</th>
          <th className="px-1.5 py-1 text-right">OT</th>
          <th className="px-1.5 py-1 text-right">DT</th>
          <th className="px-1.5 py-1 text-right">Callout</th>
          <th className="px-1.5 py-1 text-right">Km (int / cust)</th>
          <th className="px-1.5 py-1 text-right">Hm</th>
        </tr>
      </thead>
      <tbody>
        {document.rows.map((row, index) => (
          <tr
            key={`${row.date}-${index}`}
            className={`border-t border-steel-100 ${row.recorded ? '' : 'text-steel-400'}`}
            data-testid="timesheet-document-row"
          >
            <td className="px-1.5 py-0.5 whitespace-nowrap">
              {index > 0 && document.rows[index - 1]!.date === row.date ? '' : formatDayAndDate(row.date)}
            </td>
            <td className="px-1.5 py-0.5">{row.customer}</td>
            <td className="px-1.5 py-0.5 text-right tabular-nums">{hours(row.overtimeHours)}</td>
            <td className="px-1.5 py-0.5 text-right tabular-nums">{hours(row.doubleHours)}</td>
            <td className="px-1.5 py-0.5 text-right tabular-nums">{callout(row)}</td>
            <td className="px-1.5 py-0.5 text-right tabular-nums">{km(row)}</td>
            <td className="px-1.5 py-0.5" />
          </tr>
        ))}
        <tr className="border-t-2 border-steel-300 font-bold">
          <td />
          <td className="px-1.5 py-1">Totals</td>
          <td className="px-1.5 py-1 text-right tabular-nums">{document.totals.overtimeHours.toFixed(2)}</td>
          <td className="px-1.5 py-1 text-right tabular-nums">{document.totals.doubleHours.toFixed(2)}</td>
          <td className="px-1.5 py-1 text-right tabular-nums">{formatCurrency(document.totals.calloutAmount)}</td>
          <td className="px-1.5 py-1 text-right tabular-nums">
            {document.totals.internalKm.toFixed(1)} / {document.totals.customerKm.toFixed(1)}
          </td>
          <td />
        </tr>
      </tbody>
    </table>

    <div className="mt-3 space-y-0.5 text-[10px] text-steel-500">
      {document.totals.historicalNormalHours > 0 && (
        <p>NT entered before 28 October 2026 (no longer recorded): {document.totals.historicalNormalHours.toFixed(2)} hours, kept as entered.</p>
      )}
      {document.totals.historicalCallouts > 0 && (
        <p>Call-outs counted before 28 October 2026 (now an amount): {document.totals.historicalCallouts}, kept as entered.</p>
      )}
      {document.absences.map((absence) => (
        <p key={absence.date}>
          {formatDayAndDate(absence.date)}: {absence.reason}.
        </p>
      ))}
    </div>

    <section className="mt-4 min-h-24 rounded border border-steel-300 p-3" data-testid="timesheet-document-comments">
      <p className="text-[10px] font-bold tracking-wide text-steel-500 uppercase">Comments</p>
      <p className="mt-1 whitespace-pre-wrap">{document.comment}</p>
    </section>
  </article>
);
