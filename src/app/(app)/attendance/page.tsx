'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button, Card, Icon } from '@/components/ui';
import { DocumentPreviewDialog } from '@/components/documents/DocumentPreviewDialog';
import {
  AttendanceRangeFields,
  MyAttendance,
  useAttendanceRange,
} from '@/components/attendance/MyAttendance';
import { attendance, payroll } from '@/api/endpoints';
import { CompleteFormDialog } from '@/components/payroll/CompleteFormDialog';
import { useCurrentUser } from '@/providers/AppProvider';
import { useQuery } from '@/hooks/useQuery';
import { formatPeriod } from '@/lib/timesheet-dates';

/**
 * ATTENDANCE — EVERYBODY'S OWN. ATTEND-2, ATT-OWN-1 (the tester, 1 November 2026).
 *
 * FORMS-PAGES-1 (2 November 2026): the same first two blocks as the Timesheets
 * page — the From and To top-right, then the period with Preview and Print —
 * and then the person's own days, which save themselves (ATT-AUTO-1). Nothing
 * about a timesheet is on this page, and there is no Month selector, Download
 * or Submit: the monthly forms are downloaded and submitted on Monthly Forms.
 * Nothing here waits for the month to end.
 *
 * FORM-LIFECYCLE-1 (the owner, 6 November 2026): Present and Absent toggle
 * (pressed again, the day is Not recorded), and **Completed** finalises the
 * attendance for From–To — named, locked and moved to My Monthly Forms, where
 * it is submitted to the office with the timesheet. The page then opens on
 * the next period.
 *
 * FORM-WITHDRAW-1: a completed attendance withdrawn on My Monthly Forms comes
 * back here as a CORRECTION DRAFT for its own dates — said at the top, the
 * page opened on those dates — and is completed again from here.
 */
const AttendancePage = () => {
  const { range, usable, choose, today } = useAttendanceRange();
  const user = useCurrentUser();
  const [previewing, setPreviewing] = useState<'preview' | 'print' | null>(null);
  const [completing, setCompleting] = useState(false);
  const [justCompleted, setJustCompleted] = useState<{ readonly fileName: string; readonly periodLabel: string } | null>(null);
  const [unsaved, setUnsaved] = useState(0);
  const onUnsaved = useCallback((count: number) => setUnsaved(count), []);
  const label = formatPeriod(range.from, range.to);
  const forms = useQuery(`payroll:completed:${user.id}`, () => payroll.completed(user.id));
  const draft = forms.data?.drafts.attendance ?? null;
  // A correction opens on its own dates, once; the person may still look at other dates.
  const jumped = useRef<string | null>(null);
  useEffect(() => {
    if (draft === null || jumped.current === draft.id) return;
    jumped.current = draft.id;
    if (range.from !== draft.from || range.to !== draft.to) choose({ from: draft.from, to: draft.to });
  }, [draft, range.from, range.to, choose]);

  return (
    <>
      <PageHeader
        title="Attendance"
        description="Mark yourself Present or Absent for each day — press it again to clear it. Each choice saves by itself. When the period is done, press Completed: the attendance is locked and moves to My Monthly Forms, where both your forms are submitted to the office together."
      />
{draft !== null && (
        <div className="mb-5 rounded-[var(--radius-control)] border border-amber-eje-200 bg-amber-eje-50 p-3 text-sm text-steel-800" role="note" data-testid="attendance-correction-draft">
          <p className="font-semibold">Correction draft — attendance for {draft.periodLabel}</p>
          <p className="mt-1">
            You withdrew “{draft.withdrawnFileName}” to correct it. It is kept on My Monthly Forms exactly as it was completed; this is a
            separate draft with the same days. Correct it here, then press <strong>Completed</strong> for {draft.periodLabel}
            {' '}— only the completed correction can be submitted to the office.
          </p>
          {(range.from !== draft.from || range.to !== draft.to) && (
            <Button className="mt-2" size="sm" variant="secondary" onClick={() => choose({ from: draft.from, to: draft.to })} data-testid="attendance-correction-draft-dates">
              Show {draft.periodLabel}
            </Button>
          )}
        </div>
      )}
      {/* The first block: the period's From and To, top-right — where the Month selector was. */}
      <Card className="mb-5" data-testid="attendance-filters">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-steel-900">Period</p>
            <p className="text-xs text-steel-500">Choose the days to show, at most 92. Your monthly form is submitted on Monthly Forms.</p>
          </div>
          <AttendanceRangeFields range={range} today={today} onChange={choose} />
        </div>
      </Card>
      <DocumentPreviewDialog
        open={previewing !== null}
        autoPrint={previewing === 'print'}
        allowDownload={false}
        title={`Attendance — ${label}`}
        description="Preview only. Nothing is saved or sent by looking at it; submit on Monthly Forms."
        loadPdf={() => attendance.periodPdf(range.from, range.to)}
        onClose={() => setPreviewing(null)}
      />
      {usable && (
        <Card className="mb-5" data-testid="attendance-period">
          <p className="text-sm font-semibold text-steel-900" data-testid="attendance-period-label">
            Attendance period: {label}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="secondary"
              leadingIcon={<Icon name="document" className="size-4" />}
              onClick={() => setPreviewing('preview')}
              data-testid="attendance-preview"
            >
              Preview
            </Button>
            <Button
              variant="secondary"
              leadingIcon={<Icon name="document" className="size-4" />}
              onClick={() => setPreviewing('print')}
              data-testid="attendance-print"
            >
              Print
            </Button>
            <Button
              leadingIcon={<Icon name="check" className="size-4" />}
              disabled={unsaved > 0}
              onClick={() => {
                setJustCompleted(null);
                setCompleting(true);
              }}
              data-testid="attendance-complete"
            >
              Completed
            </Button>
          </div>
          {unsaved > 0 && (
            <p className="mt-2 text-xs text-steel-600" data-testid="attendance-complete-wait">
              Completed is offered once every choice is saved.
            </p>
          )}
        </Card>
      )}
      {justCompleted !== null && (
        <p role="status" className="mb-5 rounded-[var(--radius-control)] border border-verdant-200 bg-verdant-50 px-3 py-2 text-sm text-verdant-700" data-testid="attendance-completed-notice">
          Your attendance “{justCompleted.fileName}” for {justCompleted.periodLabel} is completed and locked. It is on{' '}
          <a href="/payroll/mine" className="font-medium underline">My Monthly Forms</a>, waiting to be submitted to the office with your other form.
        </p>
      )}
      {usable && (
        <CompleteFormDialog
          open={completing}
          userId={user.id}
          kind="attendance"
          from={range.from}
          to={range.to}
          onCancel={() => setCompleting(false)}
          onCompleted={(form) => {
            setCompleting(false);
            setJustCompleted({ fileName: form.fileName, periodLabel: form.periodLabel });
            forms.refetch();
            // A clean page for the next period: the day after it, to today.
            void payroll.completed(user.id).then((state) => choose(state.next), () => undefined);
          }}
        />
      )}
      <MyAttendance range={range} usable={usable} onUnsaved={onUnsaved} />
    </>
  );
};

export default AttendancePage;
