'use client';

import { useState } from 'react';
import type { User } from '@/domain';
import type { ApiErrorCode } from '@/api/client';
import { Badge, Button, Card, EmptyState, Icon, LoadingPanel, QueryFailure } from '@/components/ui';
import { DocumentPreviewDialog } from '@/components/documents/DocumentPreviewDialog';
import { DownloadFileButton } from '@/components/exports/DownloadFileButton';
import { ExportPdfButton } from '@/components/exports/ExportPdfButton';
import { TimesheetCorrections } from '@/components/timesheets/TimesheetCorrections';
import { TimesheetDocumentView } from '@/components/timesheets/TimesheetDocumentView';
import { timesheets } from '@/api/endpoints';
import type { TimesheetSubmissionView } from '@/application/timesheets';
import { useQuery } from '@/hooks/useQuery';
import { formatDateTime } from '@/lib/format';

/**
 * SUBMITTED TIMESHEETS. TS-PAPER (4 November 2026).
 *
 * The technician's own submissions under their sheet, and — for the office —
 * everybody's: who, From, To, when and by whom, how many lines, the version in
 * force, and whether a later submission replaced it. Each one opens exactly as
 * it was submitted (Preview, PDF); the office also exports its lines. A current
 * submission is CORRECTED, never edited: the technician asks with a reason and
 * the corrected lines, the office accepts or rejects, and the original is kept.
 */
export const TimesheetSubmissions = ({
  user,
  submissions,
  loading,
  error,
  errorCode,
  onRetry,
  showTechnician,
  customers,
  onChanged,
}: {
  readonly user: User;
  readonly submissions: readonly TimesheetSubmissionView[] | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly errorCode?: ApiErrorCode | null;
  readonly onRetry: () => void;
  /** The office's list names the technician on each row. */
  readonly showTechnician: boolean;
  readonly customers: readonly { readonly id: string; readonly name: string }[];
  readonly onChanged: () => void;
}) => {
  // Which submission is open, and which version of it: the version in force, or the original snapshot.
  const [viewing, setViewing] = useState<{ readonly submission: TimesheetSubmissionView; readonly version: 'current' | 'original' } | null>(null);
  const [correcting, setCorrecting] = useState<string | null>(null);
  const office = showTechnician;
  const document = useQuery(`timesheets:submission:${viewing?.submission.id ?? 'none'}:${viewing?.version ?? ''}`, () =>
    viewing === null ? Promise.resolve(null) : timesheets.submission(viewing.submission.id, viewing.version),
  );

  if (error !== null) return <QueryFailure code={errorCode ?? null} message={error} onRetry={onRetry} />;
  if (loading || submissions === null) return <LoadingPanel rows={3} label="Loading submitted timesheets" />;
  if (submissions.length === 0) {
    return (
      <EmptyState
        title="No timesheets submitted yet"
        description={office ? 'Submitted timesheets appear here as each technician submits theirs.' : 'When you submit your timesheet it is kept here exactly as you sent it.'}
        icon={<Icon name="clock" />}
      />
    );
  }

  return (
    <>
      {viewing !== null && (
        <DocumentPreviewDialog
          open
          title={`Time Sheet — ${viewing.submission.technicianName} — ${viewing.submission.label}${viewing.version === 'original' ? ' — ORIGINAL SUBMISSION' : ''}`}
          description={`Submitted ${formatDateTime(viewing.submission.submittedAt)}${viewing.submission.submittedByName === null ? '' : ` by ${viewing.submission.submittedByName}`}. ${viewing.version === 'original' ? 'The original snapshot, exactly as submitted.' : `The version in force: ${viewing.submission.versionInForce}.`}${viewing.submission.current ? '' : ' Replaced by a later submission.'}`}
          loadPdf={() => timesheets.submissionPdf(viewing.submission.id, `time-sheet-${viewing.submission.from}-to-${viewing.submission.to}${viewing.version === 'original' ? '-original' : ''}.pdf`, viewing.version)}
          renderHtml={() => (document.data === null || document.data === undefined ? null : <TimesheetDocumentView document={document.data} />)}
          onClose={() => setViewing(null)}
        />
      )}
      <ul className="divide-y divide-steel-100" data-testid="timesheet-submissions">
        {submissions.map((submission) => (
          <li
            key={submission.id}
            className="py-3"
            data-testid="timesheet-submission"
            data-from={submission.from}
            data-to={submission.to}
            data-current={submission.current ? 'yes' : 'no'}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <p className="font-semibold text-steel-900">
                  {showTechnician && <span data-testid="timesheet-submission-technician">{submission.technicianName} — </span>}
                  <span data-testid="timesheet-submission-label">{submission.label}</span>
                </p>
                <p className="text-sm text-steel-600">
                  Submitted {formatDateTime(submission.submittedAt)}
                  {submission.submittedByName === null ? '' : ` by ${submission.submittedByName}`} · {submission.lineCount} line
                  {submission.lineCount === 1 ? '' : 's'}
                </p>
                <div className="flex flex-wrap gap-2">
                  {submission.current ? (
                    <Badge tone="green" size="sm">{submission.versionInForce}</Badge>
                  ) : (
                    <Badge tone="outline" size="sm">Replaced {submission.replacedAt === null ? '' : formatDateTime(submission.replacedAt)} by a later submission</Badge>
                  )}
                  {submission.correctionPending && <Badge tone="amber" size="sm">Correction waiting for the office</Badge>}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {/* TS-PAPER-8: the original snapshot, always; the corrected version beside it when there is one. */}
                <Button size="sm" variant="secondary" leadingIcon={<Icon name="document" className="size-4" />} onClick={() => setViewing({ submission, version: 'original' })} data-testid="timesheet-submission-view-original">
                  View original
                </Button>
                {submission.versionInForce.startsWith('Correction') ? (
                  <Button size="sm" variant="secondary" leadingIcon={<Icon name="document" className="size-4" />} onClick={() => setViewing({ submission, version: 'current' })} data-testid="timesheet-submission-view">
                    View corrected version
                  </Button>
                ) : (
                  <span className="sr-only" data-testid="timesheet-submission-view-same">The original is the version in force.</span>
                )}
                <ExportPdfButton
                  href={`/api/timesheets/submissions/${encodeURIComponent(submission.id)}/pdf`}
                  fallbackName={`time-sheet-${submission.from}-to-${submission.to}.pdf`}
                  label="PDF"
                  testId="timesheet-submission-pdf"
                />
                {office && (
                  <DownloadFileButton
                    href={timesheets.submissionExportUrl(submission.id)}
                    fallbackName={`eje-timesheet-${submission.from}-to-${submission.to}.csv`}
                    label="Export CSV"
                    testId="timesheet-submission-csv"
                  />
                )}
                {submission.current && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setCorrecting(correcting === submission.id ? null : submission.id)}
                    data-testid="timesheet-submission-corrections"
                  >
                    {correcting === submission.id ? 'Close corrections' : 'Corrections'}
                  </Button>
                )}
              </div>
            </div>
            {correcting === submission.id && (
              <SubmissionCorrections user={user} submission={submission} customers={customers} onChanged={onChanged} />
            )}
          </li>
        ))}
      </ul>
    </>
  );
};

/** The correction workflow (TS-16) for one current submission: its period, as the sheet reads it. */
const SubmissionCorrections = ({
  user,
  submission,
  customers,
  onChanged,
}: {
  readonly user: User;
  readonly submission: TimesheetSubmissionView;
  readonly customers: readonly { readonly id: string; readonly name: string }[];
  readonly onChanged: () => void;
}) => {
  const sheet = useQuery(`timesheets:corrections:${submission.id}`, () =>
    timesheets.sheet(submission.technicianId, submission.from, submission.to),
  );
  if (sheet.error !== null) return <QueryFailure code={sheet.errorCode} message={sheet.error} onRetry={sheet.refetch} />;
  if (sheet.loading || sheet.data === null || sheet.data === undefined) return <LoadingPanel rows={2} label="Loading the corrections" />;
  return (
    <Card className="mt-3" data-testid="timesheet-submission-correction-panel">
      <TimesheetCorrections
        user={user}
        personId={submission.technicianId}
        period={sheet.data.period}
        entries={sheet.data.days.flatMap((day) => day.entries)}
        owner={user.id === submission.technicianId}
        customers={customers}
        onChanged={() => {
          sheet.refetch();
          onChanged();
        }}
      />
    </Card>
  );
};
