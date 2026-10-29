'use client';

import { useState } from 'react';
import { Badge, Button, Card, ConfirmDialog, Icon, LoadingPanel, QueryFailure } from '@/components/ui';
import { DocumentPreviewDialog } from '@/components/documents/DocumentPreviewDialog';
import { DownloadFileButton } from '@/components/exports/DownloadFileButton';
import { TimesheetDocumentView } from '@/components/timesheets/TimesheetDocumentView';
import { AttendanceDocumentView } from '@/components/payroll/AttendanceDocumentView';
import { payroll } from '@/api/endpoints';
import type { AttendanceDocument } from '@/application/attendance-document';
import type { TimesheetDocument } from '@/application/timesheets';
import { useQuery } from '@/hooks/useQuery';
import { useOperation } from '@/hooks/useOperation';
import { formatDateTime } from '@/lib/format';
import { formatDayAndDate } from '@/lib/timesheet-dates';

type Kind = 'timesheet' | 'attendance';

/**
 * A TECHNICIAN'S MONTHLY FORMS. PAY-01, PAY-02 (29 October 2026).
 *
 * Both documents of the month side by side, each with Preview, Print, Download
 * PDF and Export PDF — the same one-page PDF, under its file name ("JC
 * TIMESHEET OCT.pdf", "JC ATTEN OCTOBER.pdf"). The technician submits the two
 * TOGETHER, once; anything that stops it is said in plain words first. The
 * office opens the same card for any technician to read and print.
 */
export const MonthlyFormsCard = ({ userId, month }: { readonly userId: string; readonly month: string }) => {
  const operation = useOperation();
  const [previewing, setPreviewing] = useState<{ kind: Kind; print: boolean } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const forms = useQuery(`payroll:forms:${userId}:${month}`, () => payroll.forms(userId, month));
  const timesheet = useQuery(`payroll:timesheet:${userId}:${month}`, () => payroll.timesheet(userId, month));
  const attendance = useQuery(`payroll:attendance:${userId}:${month}`, () => payroll.attendance(userId, month));

  if (forms.error !== null) return <QueryFailure code={forms.errorCode} message={forms.error} onRetry={forms.refetch} />;
  if (forms.loading || forms.data === null || forms.data === undefined) return <LoadingPanel rows={3} label="Loading the monthly forms" />;
  const state = forms.data;
  const unrecorded = state.attendance.unrecordedWeekdays;

  const submit = async () => {
    setConfirm(false);
    const ok = await operation.run(async () => {
      await payroll.submit(userId, month, unrecorded.length > 0 && acknowledged);
    });
    if (ok) {
      setDone(`${state.monthLabel} submitted to the office: ${state.fileNames.timesheet} and ${state.fileNames.attendance}.`);
      forms.refetch();
      timesheet.refetch();
      attendance.refetch();
    }
  };

  const documentCard = (kind: Kind) => {
    const fileName = kind === 'timesheet' ? state.fileNames.timesheet : state.fileNames.attendance;
    const href = `/api/payroll/${encodeURIComponent(userId)}/${encodeURIComponent(month)}/${kind}/pdf`;
    return (
      <div className="rounded-[var(--radius-control)] border border-steel-200 p-3" data-testid={`monthly-${kind}`}>
        <p className="text-sm font-semibold text-steel-900">{kind === 'timesheet' ? 'Timesheet' : 'Attendance'}</p>
        <p className="mt-0.5 text-xs text-steel-500" data-testid={`monthly-${kind}-file`}>{fileName} · one page</p>
        {kind === 'timesheet' && (
          <p className="mt-1 text-xs text-steel-600">
            {state.timesheet.sent ? `Sent — ${state.timesheet.versionInForce}` : 'Not sent yet'}
            {state.timesheet.correctionPending ? ' · a correction is waiting for the office' : ''}
          </p>
        )}
        {kind === 'attendance' && (
          <p className="mt-1 text-xs text-steel-600">
            {unrecorded.length > 0 ? `${unrecorded.length} weekday${unrecorded.length === 1 ? '' : 's'} not recorded` : 'Every weekday recorded'}
            {state.attendance.changedAfterSubmission.length > 0 ? ` · corrected by the office after submission (${state.attendance.changedAfterSubmission.length})` : ''}
          </p>
        )}
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" leadingIcon={<Icon name="document" className="size-4" />} onClick={() => setPreviewing({ kind, print: false })} data-testid={`monthly-${kind}-preview`}>
            Preview
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setPreviewing({ kind, print: true })} data-testid={`monthly-${kind}-print`}>
            Print
          </Button>
          <DownloadFileButton href={href} fallbackName={fileName} label="Export PDF" />
        </div>
      </div>
    );
  };

  const preview = previewing === null ? null : previewing.kind;
  const previewFile = preview === 'attendance' ? state.fileNames.attendance : state.fileNames.timesheet;

  return (
    <Card className="mb-5" data-testid="monthly-forms">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm font-semibold text-steel-900" data-testid="monthly-forms-title">
          {state.technician.name} — {state.monthLabel}
        </p>
        {state.submission === null ? (
          <Badge tone="amber" size="sm">Not submitted</Badge>
        ) : (
          <span data-testid="monthly-forms-submitted">
            <Badge tone="green" size="sm">
              Submitted {formatDateTime(state.submission.submittedAt)}
              {state.submission.submittedByName ? ` by ${state.submission.submittedByName}` : ''}
            </Badge>
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-steel-500">
        Files are named by the name on documents “{state.technician.documentName}” (set by the office in Administration → Users).
      </p>
      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
        {documentCard('timesheet')}
        {documentCard('attendance')}
      </div>

      {state.problems.length > 0 && state.submission === null && (
        <ul className="mt-3 list-disc space-y-0.5 pl-5 text-sm text-amber-eje-700" data-testid="monthly-forms-problems">
          {state.problems.map((problem) => <li key={problem}>{problem}</li>)}
        </ul>
      )}

      {state.owner && state.submission === null && (
        <div className="mt-3 space-y-2">
          {unrecorded.length > 0 && state.canSubmit && (
            <label className="flex items-start gap-2 text-sm text-steel-700">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
                className="mt-0.5 size-4.5 rounded border-steel-300 text-eje-600"
                data-testid="monthly-forms-acknowledge"
              />
              No attendance is recorded for {unrecorded.map(formatDayAndDate).join(', ')}. I confirm the attendance is right as it is.
            </label>
          )}
          <Button
            disabled={!state.canSubmit || (unrecorded.length > 0 && !acknowledged)}
            loading={operation.running}
            onClick={() => setConfirm(true)}
            data-testid="monthly-forms-submit"
          >
            Submit {state.monthLabel} to the office
          </Button>
        </div>
      )}
      {done !== null && <p role="status" className="mt-2 text-sm text-verdant-700" data-testid="monthly-forms-done">{done}</p>}
      {operation.error !== null && <p role="alert" className="mt-2 text-sm font-medium text-signal-600" data-testid="monthly-forms-error">{operation.error}</p>}

      <ConfirmDialog
        open={confirm}
        title={`Submit ${state.monthLabel} to the office?`}
        message={`Your timesheet (${state.fileNames.timesheet}) and attendance (${state.fileNames.attendance}) go together, once. Afterwards you can no longer change that month's lines or attendance; a timesheet mistake is put right by a correction the office accepts.`}
        confirmLabel="Submit both"
        busy={operation.running}
        onConfirm={() => void submit()}
        onCancel={() => setConfirm(false)}
      />

      <DocumentPreviewDialog
        open={previewing !== null}
        autoPrint={previewing?.print === true}
        title={`${preview === 'attendance' ? 'Attendance' : 'Time Sheet'} — ${state.technician.name}, ${state.monthLabel}`}
        description={`${previewFile} — exactly the one-page PDF that is downloaded, printed and sent to Finance. Looking at it changes nothing.`}
        loadPdf={() => (preview === 'attendance' ? payroll.attendancePdf(userId, month, previewFile) : payroll.timesheetPdf(userId, month, previewFile))}
        renderHtml={() =>
          preview === 'attendance'
            ? attendance.data === null || attendance.data === undefined ? null : <AttendanceDocumentView document={attendance.data as AttendanceDocument} />
            : timesheet.data === null || timesheet.data === undefined ? null : <TimesheetDocumentView document={timesheet.data as TimesheetDocument} />
        }
        onClose={() => setPreviewing(null)}
      />
    </Card>
  );
};
