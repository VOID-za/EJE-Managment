'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, LoadingPanel, Modal, QueryFailure, TextField } from '@/components/ui';
import { ApiRequestError, newIdempotencyKey } from '@/api/client';
import { payroll } from '@/api/endpoints';
import type { CompletedFormView } from '@/application/payroll-completions';
import { useQuery } from '@/hooks/useQuery';
import { normalisePdfFileName } from '@/lib/pdf-file-name';
import { formatDayAndDate, formatPeriod } from '@/lib/timesheet-dates';

const KIND_TEXT = { timesheet: 'timesheet', attendance: 'attendance form' } as const;

/**
 * COMPLETE THIS FORM? FORM-LIFECYCLE-1 (the owner, 6 November 2026).
 *
 * Opened by **Completed** on the Timesheets or Attendance page. It says what
 * completing does — the form is finalised, locked and moved to My Monthly
 * Forms, to be submitted to the office there with the other form — shows the
 * form's name, ready to be changed, and anything that stops it (checked by
 * the server, not here). **Cancel** changes nothing. **OK** asks the server to
 * complete it; a repeated press or a retry after a lost answer is the same
 * request (one idempotency key per attempt), so it is never completed twice.
 */
export const CompleteFormDialog = ({
  open,
  userId,
  kind,
  from,
  to,
  onCancel,
  onCompleted,
}: {
  readonly open: boolean;
  readonly userId: string;
  readonly kind: 'timesheet' | 'attendance';
  readonly from: string;
  readonly to: string;
  readonly onCancel: () => void;
  readonly onCompleted: (form: CompletedFormView) => void;
}) => {
  const check = useQuery(`payroll:complete-check:${open ? 'open' : 'closed'}:${userId}:${kind}:${from}:${to}`, () =>
    open ? payroll.checkCompletion(userId, kind, from, to) : Promise.resolve(null),
  );
  const [name, setName] = useState<string | null>(null);
  const [confirmUnrecorded, setConfirmUnrecorded] = useState(false);
  const [confirmNoLines, setConfirmNoLines] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // One key per attempt: the same request again (a double press, a lost answer) is answered once.
  const key = useRef<{ value: string; request: string } | null>(null);

  useEffect(() => {
    if (open) return;
    // Closed: the next opening starts afresh from what the server proposes.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a closed dialog forgets what was typed in it.
    setName(null);
    setConfirmUnrecorded(false);
    setConfirmNoLines(false);
    setFailure(null);
    key.current = null;
  }, [open]);

  const data = check.data ?? null;
  const shownName = name ?? data?.fileName ?? '';
  const nameProblem = shownName.trim() === '' ? null : normalisePdfFileName(shownName);
  const blocked = data === null || data.problems.length > 0;
  const confirmations = data !== null && ((data.needs.confirmUnrecorded && !confirmUnrecorded) || (data.needs.confirmNoLines && !confirmNoLines));
  const canOk = !blocked && !confirmations && !busy && (nameProblem === null || nameProblem.ok);

  const complete = async () => {
    if (!canOk) return;
    const input = { kind, from, to, fileName: shownName, confirmUnrecorded, confirmNoLines };
    const request = JSON.stringify(input);
    if (key.current === null || key.current.request !== request) key.current = { value: newIdempotencyKey(), request };
    setBusy(true);
    setFailure(null);
    try {
      const form = await payroll.complete(userId, input, key.current.value);
      onCompleted(form);
    } catch (cause) {
      const unanswered = !(cause instanceof ApiRequestError) || cause.code === 'network' || cause.code === 'internal_error';
      // A refusal is final for this request; an unanswered one keeps its key, so trying again cannot complete it twice.
      if (!unanswered) key.current = null;
      setFailure(
        cause instanceof ApiRequestError
          ? `${cause.message}${cause.violations.length > 0 ? ` ${cause.violations.map((violation) => violation.message).join(' ')}` : ''}${unanswered ? ' Nothing is lost: press OK to try again.' : ''}`
          : 'The form could not be completed. Nothing is lost: press OK to try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="Complete this form?"
      onClose={busy ? () => undefined : onCancel}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy} data-testid="complete-form-cancel">
            Cancel
          </Button>
          <Button onClick={() => void complete()} loading={busy} disabled={!canOk} data-testid="complete-form-ok">
            OK
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-steel-700" data-testid="complete-form-dialog" data-kind={kind}>
        <p data-testid="complete-form-explanation">
          Completing this form will finalise it and transfer it to My Monthly Forms. <strong>Once completed, it cannot be edited again.</strong> You can
          still preview, print, download and save the PDF. You will submit it to the Office from My Monthly Forms when both forms are ready.
        </p>
        <p>
          Your {KIND_TEXT[kind]} for <strong data-testid="complete-form-period">{formatPeriod(from, to)}</strong>.
        </p>
        {check.error !== null ? (
          <QueryFailure code={check.errorCode} message={check.error} onRetry={check.refetch} />
        ) : data === null ? (
          <LoadingPanel rows={2} label="Checking the form" />
        ) : (
          <>
            <TextField
              label="Form name"
              value={shownName}
              maxLength={200}
              onChange={(event) => setName(event.target.value)}
              error={nameProblem !== null && !nameProblem.ok ? nameProblem.problem : undefined}
              hint="Shown on My Monthly Forms and in the history, and used when the PDF is saved."
              data-testid="complete-form-name"
            />
            {data.mustMatch !== null && data.problems.length === 0 && (
              <p className="text-xs text-steel-600">Your other form is completed for the same dates, {formatPeriod(data.mustMatch.from, data.mustMatch.to)}.</p>
            )}
            {data.problems.length > 0 && (
              <div role="alert" className="rounded-[var(--radius-control)] border border-amber-eje-200 bg-amber-eje-50 p-3 text-amber-eje-700" data-testid="complete-form-problems">
                <p className="font-semibold">It cannot be completed yet</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  {data.problems.map((problem) => <li key={problem}>{problem}</li>)}
                </ul>
              </div>
            )}
            {data.problems.length === 0 && data.needs.confirmUnrecorded && (
              <label className="flex min-h-11 cursor-pointer items-start gap-2 py-1">
                <input type="checkbox" className="mt-1 size-4.5" checked={confirmUnrecorded} onChange={(event) => setConfirmUnrecorded(event.target.checked)} data-testid="complete-form-confirm-unrecorded" />
                <span>
                  {data.unrecordedWeekdays.length} weekday{data.unrecordedWeekdays.length === 1 ? ' is' : 's are'} Not recorded ({data.unrecordedWeekdays.slice(0, 6).map(formatDayAndDate).join(', ')}
                  {data.unrecordedWeekdays.length > 6 ? ', …' : ''}). I confirm the attendance is right as it is.
                </span>
              </label>
            )}
            {data.problems.length === 0 && data.needs.confirmNoLines && (
              <label className="flex min-h-11 cursor-pointer items-start gap-2 py-1">
                <input type="checkbox" className="mt-1 size-4.5" checked={confirmNoLines} onChange={(event) => setConfirmNoLines(event.target.checked)} data-testid="complete-form-confirm-no-lines" />
                <span>The timesheet has no lines for these dates. I confirm I have nothing to claim.</span>
              </label>
            )}
          </>
        )}
        {failure !== null && (
          <p role="alert" className="font-medium text-signal-600" data-testid="complete-form-failure">
            {failure}
          </p>
        )}
      </div>
    </Modal>
  );
};
