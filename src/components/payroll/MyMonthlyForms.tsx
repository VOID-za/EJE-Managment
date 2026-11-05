'use client';

import { useEffect, useRef, useState } from 'react';
import { Badge, Button, ButtonLink, Card, ConfirmDialog, Icon, LoadingPanel, Modal, QueryFailure, TextField } from '@/components/ui';
import { DocumentPreviewDialog } from '@/components/documents/DocumentPreviewDialog';
import { DownloadFileButton } from '@/components/exports/DownloadFileButton';
import { ExportPdfButton } from '@/components/exports/ExportPdfButton';
import { TimesheetDocumentView } from '@/components/timesheets/TimesheetDocumentView';
import { AttendanceDocumentView } from '@/components/payroll/AttendanceDocumentView';
import { payroll } from '@/api/endpoints';
import { ApiRequestError } from '@/api/client';
import type { AttendanceDocument } from '@/application/attendance-document';
import type { PayrollFormsState, PayrollSubmissionView } from '@/application/payroll-forms';
import type { TimesheetDocument } from '@/application/timesheets';
import { useQuery } from '@/hooks/useQuery';
import { useOperation } from '@/hooks/useOperation';
import { useCurrentUser } from '@/providers/AppProvider';
import { businessToday } from '@/lib/business-time';
import { formatCurrency, formatDateTime } from '@/lib/format';
import { normalisePdfFileName } from '@/lib/pdf-file-name';
import { formatDayAndDate, isCalendarDay } from '@/lib/timesheet-dates';

type Kind = 'timesheet' | 'attendance';

const newKey = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** A link's dates (Timesheets sends its period), read once in the browser. */
const linkedPeriod = (): { from: string; to: string } | null => {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  return isCalendarDay(from) && isCalendarDay(to) && from <= to ? { from, to } : null;
};

/** RENAME A WORKING PDF: the current name, the new one checked as it is typed, saved to the server. */
const RenameDialog = ({
  open,
  kind,
  current,
  defaultName,
  userId,
  onClose,
  onRenamed,
}: {
  readonly open: boolean;
  readonly kind: Kind;
  readonly current: string;
  readonly defaultName: string;
  readonly userId: string;
  readonly onClose: () => void;
  readonly onRenamed: (name: string) => void;
}) => {
  const operation = useOperation();
  const [typed, setTyped] = useState(current);
  const checked = normalisePdfFileName(typed);
  const save = async (name: string) => {
    const result = await operation.runFor(() => payroll.rename(userId, kind, name));
    if (result !== null) onRenamed(result.fileName);
  };
  return (
    <Modal
      open={open}
      title={`Rename the ${kind === 'timesheet' ? 'timesheet' : 'attendance'} PDF`}
      description={`Now: ${current}. The new name is kept for this working PDF — for Preview, Print, Download and Save — until you submit. Renaming submits nothing and changes nothing in the document.`}
      onClose={onClose}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          {current !== defaultName && (
            <Button variant="ghost" disabled={operation.running} onClick={() => void save('')} data-testid="rename-default">
              Use the default name
            </Button>
          )}
          <Button variant="secondary" disabled={operation.running} onClick={onClose}>Cancel</Button>
          <Button loading={operation.running} disabled={!checked.ok} onClick={() => checked.ok && void save(checked.name)} data-testid="rename-save">
            Save name
          </Button>
        </div>
      }
    >
      <TextField
        label="File name"
        value={typed}
        maxLength={400}
        autoComplete="off"
        onChange={(event) => setTyped(event.target.value)}
        error={checked.ok ? undefined : checked.problem}
        hint={checked.ok ? `Saved as “${checked.name}”.` : undefined}
        data-testid="rename-input"
      />
      {operation.error !== null && (
        <p role="alert" className="mt-2 text-sm font-medium text-signal-600" data-testid="rename-error">
          {operation.error} {operation.violations.map((violation) => violation.message).join(' ')}
        </p>
      )}
    </Modal>
  );
};

/**
 * THE TWO FORMS FOR A PERIOD, AND THE ONE SUBMISSION. PAYROLL-ONE-1 (the
 * owner, 5 November 2026). Each form: its file name, Rename, Preview, Print,
 * Download PDF and Save PDF — the very PDF that is submitted, under the name
 * shown. What stops the submission is said in plain words, each with where to
 * put it right; the confirmations are explicit; Submit sends BOTH together.
 */
export const PayrollFormsPanel = ({
  userId,
  from,
  to,
  onSubmitted,
}: {
  readonly userId: string;
  readonly from: string;
  readonly to: string;
  readonly onSubmitted: () => void;
}) => {
  const operation = useOperation();
  const forms = useQuery(`payroll:period:${userId}:${from}:${to}`, () => payroll.periodForms(userId, from, to));
  const [previewing, setPreviewing] = useState<{ kind: Kind; print: boolean } | null>(null);
  const [renaming, setRenaming] = useState<Kind | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [noLines, setNoLines] = useState(false);
  const [replace, setReplace] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  /*
   * One idempotency key per submission ATTEMPTED: kept while no answer came
   * back (a lost connection), so pressing Submit again replays the same
   * request and the server answers with the submission it already made — never
   * "already submitted". A different request (other dates, other choices) gets
   * a new key.
   */
  const key = useRef<{ readonly value: string; readonly request: string } | null>(null);
  const state: PayrollFormsState | null = forms.data ?? null;
  const document = useQuery(`payroll:period-doc:${userId}:${from}:${to}:${previewing?.kind ?? 'none'}:${state?.revision ?? ''}`, () =>
    previewing === null ? Promise.resolve(null) : payroll.periodDocument<TimesheetDocument | AttendanceDocument>(userId, previewing.kind, from, to),
  );

  // Coming back to the tab: the forms are read again, so what is shown is what the server holds.
  useEffect(() => {
    const again = () => {
      if (window.document.visibilityState === 'visible') forms.refetch();
    };
    window.document.addEventListener('visibilitychange', again);
    return () => window.document.removeEventListener('visibilitychange', again);
    // The refetch is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (forms.error !== null) return <QueryFailure code={forms.errorCode} message={forms.error} onRetry={forms.refetch} />;
  if (forms.loading || state === null) return <LoadingPanel rows={3} label="Loading your forms" />;

  const unrecorded = state.attendance.unrecordedWeekdays;
  const ready =
    state.canSubmit &&
    (!state.needs.confirmUnrecorded || acknowledged) &&
    (!state.needs.confirmNoLines || noLines) &&
    (!state.needs.confirmReplace || replace);

  const submit = async () => {
    const body = {
      from,
      to,
      revision: state.revision,
      confirmUnrecorded: state.needs.confirmUnrecorded && acknowledged,
      confirmNoLines: state.needs.confirmNoLines && noLines,
      confirmReplace: state.needs.confirmReplace && replace,
    };
    const request = JSON.stringify(body);
    if (key.current?.request !== request) key.current = { value: newKey(), request };
    let unanswered = false;
    const result = await operation.runFor(async () => {
      try {
        return await payroll.submitPeriod(userId, body, key.current!.value);
      } catch (cause) {
        // No answer the server is known to have given: a lost connection, or a gateway's page in place of the server's reply.
        unanswered = !(cause instanceof ApiRequestError) || cause.code === 'network' || cause.code === 'internal_error';
        throw cause;
      }
    });
    setConfirming(false);
    if (!unanswered) key.current = null;
    if (result !== null) {
      setDone(
        `Submitted to the office ${formatDateTime(new Date().toISOString())}: ${state.timesheetRequired ? `${state.fileNames.timesheet} and ` : ''}${state.fileNames.attendance}, for ${state.periodLabel} (Finance month ${state.financeMonthLabel}). They are kept exactly as submitted.`,
      );
      setAcknowledged(false);
      setNoLines(false);
      setReplace(false);
      onSubmitted();
    }
    forms.refetch();
  };

  const section = (kind: Kind) => {
    const fileName = state.fileNames[kind];
    const href = payroll.periodPdfUrl(userId, kind, from, to);
    return (
      <div className="rounded-[var(--radius-control)] border border-steel-200 p-3" data-testid={`monthly-${kind}`}>
        <p className="text-sm font-semibold text-steel-900">{kind === 'timesheet' ? 'Timesheet' : 'Attendance'}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-steel-600">
          <span className="font-medium break-all text-steel-800" data-testid={`monthly-${kind}-file`}>{fileName}</span>
          {state.customNames[kind] && <Badge tone="outline" size="sm">Your name</Badge>}
        </p>
        <p className="mt-1 text-xs text-steel-600" data-testid={`monthly-${kind}-summary`}>
          {kind === 'timesheet' && state.timesheet !== null
            ? `${state.timesheet.lineCount} line${state.timesheet.lineCount === 1 ? '' : 's'} · OT ${state.timesheet.totals.overtimeHours.toFixed(2)} · D/T ${state.timesheet.totals.doubleHours.toFixed(2)} · Callout ${formatCurrency(state.timesheet.totals.calloutAmount)} · Int Km ${state.timesheet.totals.internalKm.toFixed(1)} · Cust Km ${state.timesheet.totals.customerKm.toFixed(1)}${state.timesheet.incomplete.length > 0 ? ` · ${state.timesheet.incomplete.length} not complete` : ''}`
            : `Present ${state.attendance.present} · Absent ${state.attendance.absent} · ${unrecorded.length > 0 ? `${unrecorded.length} weekday${unrecorded.length === 1 ? '' : 's'} not recorded` : 'every weekday recorded'}`}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" leadingIcon={<Icon name="document" className="size-4" />} onClick={() => setPreviewing({ kind, print: false })} data-testid={`monthly-${kind}-preview`}>
            Preview
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setPreviewing({ kind, print: true })} data-testid={`monthly-${kind}-print`}>
            Print
          </Button>
          <DownloadFileButton href={href} fallbackName={fileName} label="Download PDF" testId={`monthly-${kind}-download`} />
          <ExportPdfButton href={href} fallbackName={fileName} label="Save PDF" testId={`monthly-${kind}-export`} />
          {state.owner && (
            <Button size="sm" variant="ghost" onClick={() => setRenaming(kind)} data-testid={`monthly-${kind}-rename`}>
              Rename
            </Button>
          )}
        </div>
        {state.owner && (
          <ButtonLink
            href={kind === 'timesheet' ? `/timesheets?from=${from}&to=${to}` : `/attendance?from=${from}&to=${to}`}
            size="sm"
            variant="ghost"
            className="mt-1"
            data-testid={`monthly-forms-edit-${kind}`}
          >
            Edit my {kind} for these dates
          </ButtonLink>
        )}
      </div>
    );
  };

  const previewKind = previewing?.kind ?? 'attendance';
  return (
    <Card className="mb-5" data-testid="monthly-forms">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm font-semibold text-steel-900" data-testid="monthly-forms-title">
          {state.technician.name} — {state.periodLabel}
        </p>
        <Badge tone="outline" size="sm">
          <span data-testid="monthly-forms-finance-month">Finance month: {state.financeMonthLabel}</span>
        </Badge>
      </div>
      <p className="mt-1 text-xs text-steel-500">
        {state.days} day{state.days === 1 ? '' : 's'}. The Finance month is the month of To. Both forms cover exactly these dates.
      </p>
      {!state.timesheetRequired && (
        <p className="mt-3 text-sm text-steel-600" data-testid="monthly-forms-timesheet-note">
          No timesheet is required: the Office submits attendance only. The submission is recorded as attendance only.
        </p>
      )}
      <div className={`mt-3 grid grid-cols-1 gap-3 ${state.timesheetRequired ? 'md:grid-cols-2' : ''}`}>
        {state.timesheetRequired && section('timesheet')}
        {section('attendance')}
      </div>

      {state.problems.length > 0 && (
        <div className="mt-3 rounded-[var(--radius-control)] border border-amber-eje-200 bg-amber-eje-50 p-3" data-testid="monthly-forms-problems">
          <p className="text-sm font-semibold text-amber-eje-700">Before these forms can be submitted</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-amber-eje-700">
            {state.problems.map((problem) => <li key={problem}>{problem}</li>)}
          </ul>
          {(state.timesheet?.incomplete.length ?? 0) > 0 && (
            <ButtonLink href={`/timesheets?from=${from}&to=${to}`} size="sm" variant="secondary" className="mt-2" data-testid="monthly-forms-fix-lines">
              Complete or remove those lines on Timesheets
            </ButtonLink>
          )}
        </div>
      )}

      {state.replaces.length > 0 && (
        <p role="status" className="mt-3 rounded-[var(--radius-control)] border border-amber-eje-200 bg-amber-eje-50 px-3 py-2 text-sm text-amber-eje-700" data-testid="monthly-forms-replaces">
          These dates cover all of your earlier submission{state.replaces.length === 1 ? '' : 's'}: {state.replaces.map((overlap) => overlap.label).join('; ')}. Submitting REPLACES {state.replaces.length === 1 ? 'it' : 'them'} for the office and Finance. The earlier one is kept exactly as submitted, with its PDFs and names, marked replaced.
        </p>
      )}

      {state.owner && (
        <div className="mt-3 space-y-2">
          {state.needs.confirmUnrecorded && state.canSubmit && (
            <>
              <label className="flex min-h-11 cursor-pointer items-center gap-2 py-1 text-sm text-steel-700">
                <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} className="size-4.5 rounded border-steel-300 text-eje-600" data-testid="monthly-forms-acknowledge" />
                No attendance is recorded for {unrecorded.length} weekday{unrecorded.length === 1 ? '' : 's'}. I confirm the attendance is right as it is.
              </label>
              <details className="ml-6.5 text-xs text-steel-500" data-testid="monthly-forms-unrecorded">
                <summary className="cursor-pointer">Which days</summary>
                {unrecorded.map(formatDayAndDate).join(', ')}
              </details>
            </>
          )}
          {state.needs.confirmNoLines && state.canSubmit && (
            <label className="flex min-h-11 cursor-pointer items-center gap-2 py-1 text-sm text-steel-700">
              <input type="checkbox" checked={noLines} onChange={(event) => setNoLines(event.target.checked)} className="size-4.5 rounded border-steel-300 text-eje-600" data-testid="monthly-forms-no-lines" />
              My timesheet has no lines for these dates: I have nothing to claim.
            </label>
          )}
          {state.needs.confirmReplace && state.canSubmit && (
            <label className="flex min-h-11 cursor-pointer items-center gap-2 py-1 text-sm text-steel-700">
              <input type="checkbox" checked={replace} onChange={(event) => setReplace(event.target.checked)} className="size-4.5 rounded border-steel-300 text-eje-600" data-testid="monthly-forms-confirm-replace" />
              I am replacing my earlier submission for these days.
            </label>
          )}
          <Button disabled={!ready} loading={operation.running} onClick={() => setConfirming(true)} data-testid="monthly-forms-submit">
            {state.timesheetRequired ? 'Submit timesheet and attendance' : 'Submit attendance'}
          </Button>
        </div>
      )}
      {done !== null && <p role="status" className="mt-2 text-sm text-verdant-700" data-testid="monthly-forms-done">{done}</p>}
      {operation.error !== null && (
        <p role="alert" className="mt-2 text-sm font-medium text-signal-600" data-testid="monthly-forms-error">
          {operation.error} {operation.violations.map((violation) => violation.message).join(' ')}
        </p>
      )}

      <ConfirmDialog
        open={confirming}
        title={`Submit your forms for ${state.periodLabel}?`}
        message={
          (state.timesheetRequired
            ? `Your timesheet (${state.fileNames.timesheet}) and attendance (${state.fileNames.attendance}) go to the office together, for Finance month ${state.financeMonthLabel}.`
            : `Your attendance (${state.fileNames.attendance}) goes to the office, for Finance month ${state.financeMonthLabel}.`) +
          (state.replaces.length > 0 ? ` This REPLACES ${state.replaces.map((overlap) => overlap.label).join('; ')}; the earlier one is kept, marked replaced.` : '') +
          ' What you submit is kept exactly as it is now. A change afterwards is a correction, or a complete replacement.'
        }
        confirmLabel={state.replaces.length > 0 ? 'Replace and submit' : state.timesheetRequired ? 'Submit both' : 'Submit attendance'}
        busy={operation.running}
        onConfirm={() => void submit()}
        onCancel={() => setConfirming(false)}
      />

      {renaming !== null && (
        <RenameDialog
          open
          kind={renaming}
          current={state.fileNames[renaming]}
          defaultName={state.defaultNames[renaming]}
          userId={userId}
          onClose={() => setRenaming(null)}
          onRenamed={() => {
            setRenaming(null);
            forms.refetch();
          }}
        />
      )}

      <DocumentPreviewDialog
        open={previewing !== null}
        autoPrint={previewing?.print === true}
        title={`${previewKind === 'attendance' ? 'Attendance' : 'Time Sheet'} — ${state.technician.name}, ${state.periodLabel}`}
        description={`${state.fileNames[previewKind]} — exactly the PDF that is downloaded, saved, printed and submitted. Looking at it changes nothing.`}
        loadPdf={() => payroll.periodPdf(userId, previewKind, from, to, state.fileNames[previewKind])}
        renderHtml={() =>
          document.data === null || document.data === undefined
            ? null
            : previewKind === 'attendance'
              ? <AttendanceDocumentView document={document.data as AttendanceDocument} />
              : <TimesheetDocumentView document={document.data as TimesheetDocument} />
        }
        onClose={() => setPreviewing(null)}
      />
    </Card>
  );
};

/** One past submission: what went, when, and its documents exactly as they went. */
const HistoryRow = ({ entry }: { readonly entry: PayrollSubmissionView }) => {
  const [previewing, setPreviewing] = useState<Kind | null>(null);
  const file = previewing === null ? '' : entry.fileNames[previewing];
  return (
    <li className="flex flex-wrap items-center gap-3 py-2" data-testid="my-monthly-history-row" data-from={entry.from} data-to={entry.to} data-current={entry.current ? 'yes' : 'no'}>
      <span className="min-w-40 font-medium text-steel-900">{entry.label}</span>
      <Badge tone={entry.current ? 'green' : 'outline'} size="sm">
        {entry.current ? `Submitted ${formatDateTime(entry.submittedAt)}` : `Replaced ${formatDateTime(entry.replacedAt ?? entry.submittedAt)}`}
      </Badge>
      <span className="text-xs text-steel-500">
        {entry.kind === 'monthly'
          ? `Monthly forms (before 5 November 2026)${entry.timesheetIncluded ? ' — with the month’s timesheet' : ' — attendance'}`
          : `${entry.timesheetRequired ? 'Timesheet and attendance' : 'Attendance only — no timesheet required'} · Finance ${entry.financeMonthLabel}`}
      </span>
      {entry.documents.map((document) => (
        <span key={document.kind} className="flex flex-wrap items-center gap-1">
          <span className="text-xs break-all text-steel-700" data-testid={`history-${document.kind}-file`}>{document.fileName}</span>
          <Button size="sm" variant="ghost" onClick={() => setPreviewing(document.kind)} data-testid={`history-${document.kind}-preview`}>Preview</Button>
          <DownloadFileButton href={payroll.submittedPdfUrl(entry.id, document.kind)} fallbackName={document.fileName} label="Download" testId={`history-${document.kind}-download`} />
        </span>
      ))}
      <DocumentPreviewDialog
        open={previewing !== null}
        title={`${previewing === 'timesheet' ? 'Time Sheet' : 'Attendance'} — ${entry.label}, as submitted`}
        description={`${file} — the PDF stored when it was submitted. It never changes.`}
        loadPdf={() => payroll.submittedPdf(entry.id, previewing ?? 'attendance', file)}
        onClose={() => setPreviewing(null)}
      />
    </li>
  );
};

/**
 * MY MONTHLY FORMS — THE ONE PLACE PAYROLL IS SUBMITTED. PAYROLL-ONE-1.
 * Everybody's own: choose the From and To of the pay period (any days, across
 * months and years; it opens on the day after the last submission to today),
 * review both forms, rename their PDFs, and submit them together. Below, every
 * submission, current and replaced, with its documents as they went.
 */
export const MyMonthlyForms = () => {
  const user = useCurrentUser();
  const today = businessToday();
  const [period, setPeriod] = useState<{ from: string; to: string } | null>(null);
  const history = useQuery(`payroll:period-history:${user.id}`, () => payroll.periodHistory(user.id));
  // Where it opens: a link's dates, else what the server proposes (the day after the last submission, to today).
  const start = useQuery(`payroll:period-start:${user.id}`, () => payroll.periodForms(user.id, today, today));
  useEffect(() => {
    if (period !== null) return;
    const linked = linkedPeriod();
    if (linked !== null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the first period is known once the browser has the address.
      setPeriod(linked);
      return;
    }
    if (start.data !== null && start.data !== undefined) setPeriod(start.data.suggested);
  }, [period, start.data]);
  const valid = period !== null && isCalendarDay(period.from) && isCalendarDay(period.to) && period.from <= period.to;

  return (
    <div data-testid="my-monthly-forms">
      <Card className="mb-5" data-testid="my-monthly-period">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-steel-900">Pay period</p>
            <p className="text-xs text-steel-500">From and To of the period you are submitting — any days, across months and years.</p>
          </div>
          {period !== null && (
            <div className="flex flex-wrap items-end gap-3">
              <TextField label="From" type="date" value={period.from} max={period.to} onChange={(event) => event.target.value !== '' && setPeriod({ ...period, from: event.target.value })} containerClassName="w-44" data-testid="my-monthly-from" />
              <TextField label="To" type="date" value={period.to} min={period.from} onChange={(event) => event.target.value !== '' && setPeriod({ ...period, to: event.target.value })} containerClassName="w-44" data-testid="my-monthly-to" />
            </div>
          )}
        </div>
        {period !== null && !valid && <p role="alert" className="mt-2 text-sm font-medium text-signal-600">Choose a From on or before the To.</p>}
      </Card>

      {start.error !== null && period === null ? (
        <QueryFailure code={start.errorCode} message={start.error} onRetry={start.refetch} />
      ) : !valid ? (
        <LoadingPanel rows={3} label="Loading your forms" />
      ) : (
        <PayrollFormsPanel key={`${period.from}:${period.to}`} userId={user.id} from={period.from} to={period.to} onSubmitted={history.refetch} />
      )}

      <Card className="mb-5" data-testid="my-monthly-history">
        <p className="text-sm font-semibold text-steel-900">History</p>
        <p className="text-xs text-steel-500">Everything you submitted, newest first. A replaced submission is kept, exactly as it went.</p>
        {history.error !== null ? (
          <QueryFailure code={history.errorCode} message={history.error} onRetry={history.refetch} />
        ) : history.loading || history.data === null || history.data === undefined ? (
          <LoadingPanel rows={2} label="Loading your history" />
        ) : history.data.length === 0 ? (
          <p className="mt-3 text-sm text-steel-500" data-testid="my-monthly-history-empty">Nothing submitted yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-steel-100">
            {history.data.map((entry) => <HistoryRow key={`${entry.kind}:${entry.id}`} entry={entry} />)}
          </ul>
        )}
      </Card>
    </div>
  );
};
