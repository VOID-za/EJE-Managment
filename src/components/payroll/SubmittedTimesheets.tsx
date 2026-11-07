'use client';

import { useState } from 'react';
import { can } from '@/domain';
import { Badge, Card, LoadingPanel, QueryFailure, SelectField } from '@/components/ui';
import { SubmissionCorrections, TimesheetSubmissions } from '@/components/timesheets/TimesheetSubmissions';
import { reads, timesheets } from '@/api/endpoints';
import { useQuery } from '@/hooks/useQuery';
import { useCurrentUser } from '@/providers/AppProvider';
import { formatDateTime } from '@/lib/format';

/**
 * CORRECTING A SUBMITTED TIMESHEET, ON MY MONTHLY FORMS (TS-16; placed under
 * Corrections by HISTORY-ONE-1, the owner, 7 November 2026).
 *
 * The History is read only; a submitted timesheet is changed only by asking the
 * office for a correction, with the reason and the corrected lines — the
 * original is kept exactly as submitted and stays in the History. The person's
 * OWN submitted timesheets only, and only for a role that keeps one: the server
 * refuses anybody else's, and the Office (who keeps no timesheet) is not shown
 * this at all.
 */
export const TimesheetCorrectionRequests = () => {
  const user = useCurrentUser();
  const mine = useQuery(`timesheets:working:${user.id}`, () => timesheets.working(user.id));
  const customers = useQuery('timesheets:customers:yes', () => reads.customers());
  const [chosen, setChosen] = useState('');
  const current = (mine.data?.submissions ?? []).filter((submission) => submission.current);
  const asked = current.filter((submission) => submission.correctionPending || submission.versionInForce.startsWith('Correction'));
  const open = current.find((submission) => submission.id === chosen) ?? null;

  if (mine.error !== null) return <QueryFailure code={mine.errorCode} message={mine.error} onRetry={mine.refetch} />;
  if (mine.loading || mine.data === null || mine.data === undefined) return <LoadingPanel rows={1} label="Loading your submitted timesheets" />;
  return (
    <div className="mt-4 border-t border-steel-100 pt-3" data-testid="my-timesheet-corrections">
      <p className="text-sm font-medium text-steel-900">A submitted timesheet</p>
      <p className="text-xs text-steel-500">
        To change a timesheet you submitted, ask the office for a correction with your reason. The original stays in your History exactly as it went.
      </p>
      {asked.length > 0 && (
        <ul className="mt-2 space-y-1" data-testid="my-timesheet-corrections-asked">
          {asked.map((submission) => (
            <li key={submission.id} className="flex flex-wrap items-center gap-2 text-sm" data-testid="my-timesheet-correction" data-submission={submission.id}>
              <span className="font-medium text-steel-800">Timesheet {submission.label}</span>
              <span className="text-xs text-steel-500">submitted {formatDateTime(submission.submittedAt)}</span>
              <Badge tone={submission.correctionPending ? 'amber' : 'blue'} size="sm">
                {submission.correctionPending ? 'Correction waiting for the office' : submission.versionInForce}
              </Badge>
            </li>
          ))}
        </ul>
      )}
      {current.length === 0 ? (
        <p className="mt-2 text-sm text-steel-500" data-testid="my-timesheet-corrections-none">No timesheet submitted yet.</p>
      ) : (
        <SelectField
          label="Timesheet to correct"
          value={chosen}
          onChange={(event) => setChosen(event.target.value)}
          containerClassName="mt-2 max-w-md"
          data-testid="my-timesheet-correction-choose"
          placeholder="Choose a submitted timesheet…"
          options={current.map((submission) => ({ value: submission.id, label: `${submission.label} — submitted ${formatDateTime(submission.submittedAt)}` }))}
        />
      )}
      {open !== null && (
        <SubmissionCorrections key={open.id} user={user} submission={open} customers={customers.data ?? []} onChanged={mine.refetch} />
      )}
    </div>
  );
};

/**
 * EVERY TECHNICIAN'S SUBMITTED TIMESHEETS — for the office, on EJE Monthly
 * Forms (moved off My Monthly Forms by FORMS-OWN-1, 7 November 2026: a personal
 * page shows only its own person's forms). Each opens exactly as submitted, its
 * PDF and its lines' export; the corrections asked for are decided here. The
 * server refuses it to anybody without `timesheets.viewAll`.
 */
export const OfficeSubmittedTimesheets = () => {
  const user = useCurrentUser();
  const office = can(user.role, 'timesheets.viewAll');
  const everybody = useQuery(`timesheets:submissions:all:${office ? 'yes' : 'no'}`, () => (office ? timesheets.submissions() : Promise.resolve(null)));
  const customers = useQuery(`timesheets:customers:${office ? 'yes' : 'no'}`, () => (office ? reads.customers() : Promise.resolve([])));
  if (!office) return null;
  return (
    <Card className="mb-5" data-testid="timesheet-office">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-steel-900">Submitted timesheets — every technician</h2>
        <Badge tone="outline" size="sm">Office</Badge>
      </div>
      <p className="mb-3 text-xs text-steel-500">
        Each person submits their own on My Monthly Forms. Open one to read it exactly as submitted, download its PDF or export its lines; decide the corrections asked for. The same date may be in more than one submission — each carries its own lines.
      </p>
      <TimesheetSubmissions
        user={user}
        submissions={everybody.data ?? null}
        loading={everybody.loading}
        error={everybody.error}
        errorCode={everybody.errorCode}
        onRetry={everybody.refetch}
        showTechnician
        customers={customers.data ?? []}
        onChanged={() => everybody.refetch()}
      />
    </Card>
  );
};
