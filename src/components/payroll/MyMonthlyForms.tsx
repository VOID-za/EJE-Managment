'use client';

import { useRef, useState } from 'react';
import { Badge, Button, ButtonLink, Card, ConfirmDialog, Icon, LoadingPanel, QueryFailure } from '@/components/ui';
import { DocumentPreviewDialog } from '@/components/documents/DocumentPreviewDialog';
import { DownloadFileButton } from '@/components/exports/DownloadFileButton';
import { ExportPdfButton } from '@/components/exports/ExportPdfButton';
import { SubmittedTimesheets } from '@/components/payroll/SubmittedTimesheets';
import { payroll } from '@/api/endpoints';
import { ApiRequestError, newIdempotencyKey } from '@/api/client';
import type { PayrollSubmissionView } from '@/application/payroll-forms';
import type { CompletedFormView, CorrectionView, OpenCorrectionDraft } from '@/application/payroll-completions';
import { useQuery } from '@/hooks/useQuery';
import { useCurrentUser } from '@/providers/AppProvider';
import { formatDateTime } from '@/lib/format';

type Kind = 'timesheet' | 'attendance';
const TITLE: Record<Kind, string> = { timesheet: 'Timesheet', attendance: 'Attendance' };

/**
 * ONE COMPLETED FORM, AWAITING SUBMIT TO OFFICE (FORM-LIFECYCLE-1). Its name,
 * dates and when it was completed; Preview, Print, Download and Save PDF all
 * act on the PDF stored when it was completed — never a live working copy.
 * Nothing here edits it. WITHDRAW AND CORRECT (FORM-WITHDRAW-1) takes it back
 * before it is submitted: it stays in the record exactly as completed, and a
 * correction draft opens on its page, to be completed again.
 */
const CompletedForm = ({
  kind,
  form,
  required,
  draft,
  onWithdrawn,
}: {
  readonly kind: Kind;
  readonly form: CompletedFormView | null;
  readonly required: boolean;
  /** The correction draft open for this form, when it was withdrawn. */
  readonly draft: OpenCorrectionDraft | null;
  readonly onWithdrawn: () => void;
}) => {
  const user = useCurrentUser();
  const [previewing, setPreviewing] = useState<'preview' | 'print' | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // One key per attempt: a double press, or confirming again after a lost answer, is ONE withdrawal.
  const key = useRef<{ readonly id: string; readonly key: string } | null>(null);
  const state = !required ? 'not_required' : form === null ? (draft === null ? 'not_completed' : 'correcting') : 'completed';
  const page = kind === 'timesheet' ? 'Timesheets' : 'Attendance';
  const withdraw = async () => {
    if (form === null || busy) return;
    if (key.current?.id !== form.id) key.current = { id: form.id, key: newIdempotencyKey() };
    setBusy(true);
    setFailure(null);
    try {
      await payroll.withdraw(user.id, form.id, key.current.key);
      key.current = null;
      setAsking(false);
      onWithdrawn();
    } catch (cause) {
      const unanswered = !(cause instanceof ApiRequestError) || cause.code === 'network' || cause.code === 'internal_error';
      if (!unanswered) key.current = null;
      setFailure(
        unanswered
          ? 'There was no answer from the server, so the form may or may not have been withdrawn. Confirm again: it is the same request, and it is never withdrawn twice.'
          : `${cause instanceof Error ? cause.message : 'The form could not be withdrawn.'}${cause instanceof ApiRequestError && cause.violations.length > 0 ? ` ${cause.violations.map((violation) => violation.message).join(' ')}` : ''} Nothing was withdrawn.`,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-[var(--radius-control)] border border-steel-200 p-4" data-testid={`my-forms-${kind}`} data-state={state}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-base font-semibold text-steel-900">{TITLE[kind]}</p>
        {state === 'completed' && <Badge tone="green" size="sm">Completed — awaiting submission</Badge>}
        {state === 'not_completed' && <Badge tone="amber" size="sm">Not completed</Badge>}
        {state === 'not_required' && <Badge tone="outline" size="sm">Not required</Badge>}
        {state === 'correcting' && <Badge tone="amber" size="sm">Being corrected — not completed</Badge>}
      </div>
      {state === 'correcting' && draft !== null && (
        <p className="mt-1 text-sm text-steel-600" data-testid={`my-forms-${kind}-correcting`}>
          You withdrew “{draft.withdrawnFileName}” on {formatDateTime(draft.withdrawnAt)} to correct it. Correct it on the {page} page
          ({draft.periodLabel}) and press <strong>Completed</strong> there again — it can be submitted once it is completed.{' '}
          <ButtonLink href={kind === 'timesheet' ? '/timesheets' : '/attendance'} size="sm" variant="ghost" data-testid={`my-forms-${kind}-open`}>
            Open {page}
          </ButtonLink>
        </p>
      )}
      {state === 'not_required' && (
        <p className="mt-1 text-sm text-steel-600">The Office keeps no timesheet: only the attendance form is submitted.</p>
      )}
      {state === 'not_completed' && (
        <p className="mt-1 text-sm text-steel-600">
          Not completed yet. Fill it in on the {kind === 'timesheet' ? 'Timesheets' : 'Attendance'} page and press <strong>Completed</strong> there.{' '}
          <ButtonLink href={kind === 'timesheet' ? '/timesheets' : '/attendance'} size="sm" variant="ghost" data-testid={`my-forms-${kind}-open`}>
            Open {kind === 'timesheet' ? 'Timesheets' : 'Attendance'}
          </ButtonLink>
        </p>
      )}
      {form !== null && (
        <>
          <p className="mt-1 text-sm font-medium break-all text-steel-800" data-testid={`my-forms-${kind}-file`}>
            {form.fileName}
          </p>
          <p className="text-xs text-steel-600">
            <span data-testid={`my-forms-${kind}-period`}>{form.periodLabel}</span> · {form.summary} · completed {formatDateTime(form.completedAt)}
            {form.completedByName === null ? '' : ` by ${form.completedByName}`} · locked
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" leadingIcon={<Icon name="document" className="size-4" />} onClick={() => setPreviewing('preview')} data-testid={`my-forms-${kind}-preview`}>
              Preview
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setPreviewing('print')} data-testid={`my-forms-${kind}-print`}>
              Print
            </Button>
            <DownloadFileButton href={payroll.completedPdfUrl(form.id)} fallbackName={form.fileName} label="Download" testId={`my-forms-${kind}-download`} />
            <ExportPdfButton href={payroll.completedPdfUrl(form.id)} fallbackName={form.fileName} label="Save PDF" testId={`my-forms-${kind}-export`} />
            <Button size="sm" variant="ghost" leadingIcon={<Icon name="edit" className="size-4" />} onClick={() => setAsking(true)} data-testid={`my-forms-${kind}-withdraw`}>
              Withdraw and Correct
            </Button>
          </div>
          {failure !== null && (
            <p role="alert" className="mt-2 text-sm font-medium text-signal-600" data-testid={`my-forms-${kind}-withdraw-failure`}>
              {failure}
            </p>
          )}
          <ConfirmDialog
            open={asking}
            title={`Withdraw and correct your ${kind === 'timesheet' ? 'timesheet' : 'attendance'}?`}
            message={
              <div data-testid="withdraw-form-dialog">
                <ul className="list-disc space-y-1 pl-5">
                  <li>“{form.fileName}” ({form.periodLabel}) is withdrawn: it will not be submitted to the office.</li>
                  <li>It is kept in the record exactly as it was completed — its content and its PDF are not changed.</li>
                  <li>A separate draft opens with the same {kind === 'timesheet' ? 'lines' : 'days'}, on the {page} page, for you to correct.</li>
                  <li>The correction must be completed again (Completed) before it can be submitted to the office.</li>
                  <li>Once forms are submitted to the office, they can no longer be withdrawn.</li>
                </ul>
              </div>
            }
            confirmLabel="Withdraw and Correct"
            busy={busy}
            onCancel={() => {
              setAsking(false);
              setFailure(null);
            }}
            onConfirm={() => void withdraw()}
          />
          <DocumentPreviewDialog
            open={previewing !== null}
            autoPrint={previewing === 'print'}
            title={`${TITLE[kind]} — ${form.periodLabel}, as completed`}
            description={`${form.fileName} — the PDF stored when it was completed. It cannot be changed.`}
            loadPdf={() => payroll.completedPdf(form.id, form.fileName)}
            onClose={() => setPreviewing(null)}
          />
        </>
      )}
    </div>
  );
};

/** One past submission: what went, when, and its documents exactly as they went. Read only. */
/** ONE WITHDRAWAL AND ITS CORRECTION (FORM-WITHDRAW-1): the withdrawn form, read only, and where the correction stands. */
const CorrectionRow = ({ entry }: { readonly entry: CorrectionView }) => {
  const [previewing, setPreviewing] = useState<CompletedFormView | null>(null);
  const label = {
    draft: 'Correction draft — being corrected',
    completed: 'Correction completed — awaiting submission',
    submitted: 'Correction submitted to the office',
    withdrawn: 'Correction withdrawn too — corrected again below',
  }[entry.state];
  return (
    <li className="py-3" data-testid="my-corrections-row" data-kind={entry.kind} data-state={entry.state}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold text-steel-900">{TITLE[entry.kind]} · {entry.periodLabel}</p>
        <Badge tone={entry.state === 'draft' || entry.state === 'withdrawn' ? 'amber' : 'green'} size="sm">{label}</Badge>
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <div className="rounded-[var(--radius-control)] border border-steel-200 bg-steel-50 p-2 text-sm" data-testid="my-corrections-withdrawn">
          <p className="font-medium break-all text-steel-800">{entry.withdrawn.fileName}</p>
          <p className="text-xs text-steel-600">
            Withdrawn {entry.withdrawn.withdrawnAt === null ? '' : formatDateTime(entry.withdrawn.withdrawnAt)}
            {entry.withdrawnByName === null ? '' : ` by ${entry.withdrawnByName}`} · kept exactly as completed {formatDateTime(entry.withdrawn.completedAt)} · never submitted
          </p>
          <div className="mt-1 flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => setPreviewing(entry.withdrawn)} data-testid="my-corrections-withdrawn-preview">Preview</Button>
            <DownloadFileButton href={payroll.completedPdfUrl(entry.withdrawn.id)} fallbackName={entry.withdrawn.fileName} label="Download" testId="my-corrections-withdrawn-download" />
          </div>
        </div>
        <div className="rounded-[var(--radius-control)] border border-steel-200 p-2 text-sm" data-testid="my-corrections-replacement">
          {entry.replacement === null ? (
            <p className="text-steel-600">
              Its correction is a draft on the {entry.kind === 'timesheet' ? 'Timesheets' : 'Attendance'} page. Complete it there to put it back on this page.
            </p>
          ) : (
            <>
              <p className="font-medium break-all text-steel-800">{entry.replacement.fileName}</p>
              <p className="text-xs text-steel-600">
                The correction, completed {formatDateTime(entry.replacement.completedAt)} · {{ submitted: 'submitted to the office', completed: 'awaiting submission', withdrawn: 'withdrawn as well, never submitted', draft: '' }[entry.state]}
              </p>
              <div className="mt-1 flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => setPreviewing(entry.replacement)} data-testid="my-corrections-replacement-preview">Preview</Button>
                <DownloadFileButton href={payroll.completedPdfUrl(entry.replacement.id)} fallbackName={entry.replacement.fileName} label="Download" testId="my-corrections-replacement-download" />
              </div>
            </>
          )}
        </div>
      </div>
      <DocumentPreviewDialog
        open={previewing !== null}
        title={previewing === null ? '' : `${previewing.fileName} — as completed`}
        description="The PDF stored when it was completed. It cannot be changed."
        loadPdf={() => payroll.completedPdf(previewing!.id, previewing!.fileName)}
        onClose={() => setPreviewing(null)}
      />
    </li>
  );
};

const HistoryRow = ({ entry }: { readonly entry: PayrollSubmissionView }) => {
  const [previewing, setPreviewing] = useState<Kind | null>(null);
  const file = previewing === null ? '' : entry.fileNames[previewing];
  return (
    <li className="flex flex-wrap items-center gap-3 py-2" data-testid="my-monthly-history-row" data-from={entry.from} data-to={entry.to} data-current={entry.current ? 'yes' : 'no'}>
      <span className="min-w-40 font-medium text-steel-900">{entry.label}</span>
      <Badge tone={entry.current ? 'green' : 'outline'} size="sm">
        {entry.current ? `Submitted to the office ${formatDateTime(entry.submittedAt)}` : `Replaced ${formatDateTime(entry.replacedAt ?? entry.submittedAt)}`}
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
 * MY MONTHLY FORMS — FORM-LIFECYCLE-1 (the owner, 6 November 2026).
 *
 * Everybody's own. The Timesheet, then the Attendance, each COMPLETED on its
 * own page and waiting here, locked, with its PDF as it was completed. Then
 * **Submit to Office**: enabled only when both are completed for the same
 * dates (attendance alone for the Office, who keeps no timesheet), and when
 * not, the reason is written under it. It sends both together as one
 * submission; the server checks it all again and never sends one form alone.
 * At the bottom, the HISTORY — every submission, read only, its documents as
 * they went — and the submitted timesheets with their corrections (TS-16) and,
 * for the office, every technician's (`SubmittedTimesheets`).
 */
export const MyMonthlyForms = () => {
  const user = useCurrentUser();
  const forms = useQuery(`payroll:completed:${user.id}`, () => payroll.completed(user.id));
  const history = useQuery(`payroll:period-history:${user.id}`, () => payroll.periodHistory(user.id));
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // One key per attempt: a double press, or pressing again after a lost answer, is ONE submission.
  const key = useRef<string | null>(null);
  const state = forms.data ?? null;

  const submit = async () => {
    if (state === null || state.readiness !== 'ready' || busy) return;
    key.current ??= newIdempotencyKey();
    setBusy(true);
    setFailure(null);
    try {
      await payroll.submitCompleted(user.id, key.current);
      key.current = null;
      const names = [state.timesheet?.fileName, state.attendance?.fileName].filter((name) => name !== undefined).join(' and ');
      setDone(`Submitted to the office ${formatDateTime(new Date().toISOString())}: ${names}, for ${state.attendance?.periodLabel ?? ''}. They are read only now, and kept exactly as submitted in your history below.`);
    } catch (cause) {
      const unanswered = !(cause instanceof ApiRequestError) || cause.code === 'network' || cause.code === 'internal_error';
      // An unanswered attempt keeps its key: pressing again repeats it, and the server answers it once.
      if (!unanswered) key.current = null;
      setFailure(
        unanswered
          ? 'There was no answer from the server, so the forms may or may not have gone. Press Submit to Office again: it is the same request, and it is never submitted twice.'
          : `${cause instanceof Error ? cause.message : 'The forms could not be submitted.'}${cause instanceof ApiRequestError && cause.violations.length > 0 ? ` ${cause.violations.map((violation) => violation.message).join(' ')}` : ''} Nothing was submitted; both forms still wait here.`,
      );
    } finally {
      setBusy(false);
      forms.refetch();
      history.refetch();
    }
  };

  return (
    <div data-testid="my-monthly-forms">
      <Card className="mb-5" data-testid="my-forms">
        <p className="text-sm font-semibold text-steel-900">Forms to submit</p>
        <p className="mb-3 text-xs text-steel-500">
          Each form is completed on its own page and waits here, locked. When both are completed for the same dates, submit them to the office together.
        </p>
        {forms.error !== null ? (
          <QueryFailure code={forms.errorCode} message={forms.error} onRetry={forms.refetch} />
        ) : state === null ? (
          <LoadingPanel rows={3} label="Loading your forms" />
        ) : (
          <>
            <div className="grid gap-3 lg:grid-cols-2">
              <CompletedForm kind="timesheet" form={state.timesheet} required={state.timesheetRequired} draft={state.drafts.timesheet} onWithdrawn={forms.refetch} />
              <CompletedForm kind="attendance" form={state.attendance} required draft={state.drafts.attendance} onWithdrawn={forms.refetch} />
            </div>
            <div className="mt-4 border-t border-steel-100 pt-4">
              <Button
                size="lg"
                leadingIcon={<Icon name="check" className="size-4" />}
                disabled={state.readiness !== 'ready' || busy}
                loading={busy}
                onClick={() => void submit()}
                data-testid="my-forms-submit"
                data-readiness={state.readiness}
              >
                Submit to Office
              </Button>
              {/* Said in words under the button — never only a tooltip. */}
              <p
                className={`mt-2 text-sm ${state.readiness === 'ready' ? 'text-verdant-700' : 'text-amber-eje-700'}`}
                role="status"
                data-testid="my-forms-submit-reason"
              >
                {state.readiness === 'ready' ? state.readinessText : `Submit to Office is not available yet: ${state.readinessText}`}
              </p>
            </div>
          </>
        )}
        {done !== null && (
          <p role="status" className="mt-3 rounded-[var(--radius-control)] border border-verdant-200 bg-verdant-50 px-3 py-2 text-sm text-verdant-700" data-testid="my-forms-done">
            {done}
          </p>
        )}
        {failure !== null && (
          <p role="alert" className="mt-3 text-sm font-medium text-signal-600" data-testid="my-forms-failure">
            {failure}
          </p>
        )}
      </Card>

      {/* CORRECTIONS — apart from the history: what was withdrawn, kept as completed, and its correction. */}
      <Card className="mb-5" data-testid="my-corrections">
        <p className="text-sm font-semibold text-steel-900">Corrections</p>
        <p className="text-xs text-steel-500">
          Forms you withdrew before submitting them, each kept exactly as it was completed, beside its correction. A submitted form is never withdrawn; a submitted timesheet is corrected under Submitted timesheets.
        </p>
        {state === null ? null : state.corrections.length === 0 ? (
          <p className="mt-3 text-sm text-steel-500" data-testid="my-corrections-empty">No form withdrawn.</p>
        ) : (
          <ul className="mt-1 divide-y divide-steel-100">
            {state.corrections.map((entry) => <CorrectionRow key={entry.draftId} entry={entry} />)}
          </ul>
        )}
      </Card>

      <SubmittedTimesheets />

      <Card className="mb-5" data-testid="my-monthly-history">
        <p className="text-sm font-semibold text-steel-900">History</p>
        <p className="text-xs text-steel-500">Everything you submitted to the office, newest first — read only, each document exactly as it went.</p>
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
