'use client';

import { useState } from 'react';
import { STANDBY_POSITION_LABELS } from '@/domain';
import type { StandbySwapView } from '@/application/standby';
import { Badge, Button, Card, EmptyState, Tabs, TextAreaField } from '@/components/ui';
import { standby } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';
import { formatDateTime } from '@/lib/format';
import { weekRangeLabel } from './standby-format';

const STATUS_TABS = [
  { id: 'pending', label: 'Pending' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'cancelled', label: 'Cancelled' },
] as const;

const TONE = { pending: 'amber', approved: 'green', rejected: 'red', cancelled: 'neutral' } as const;

/**
 * SWAP REQUESTS. STANDBY-7.
 *
 * The office sees every request and decides the pending ones — approve or
 * reject, with an optional note — never its own. A technician sees the requests
 * they are part of, and may withdraw their own while it is pending. A decided
 * request is history: nothing on it can be edited.
 */
export const SwapRequestsPanel = ({
  requests,
  canDecide,
  meId,
  onChanged,
}: {
  readonly requests: readonly StandbySwapView[];
  readonly canDecide: boolean;
  readonly meId: string | null;
  readonly onChanged: (message: string) => void;
}) => {
  const [tab, setTab] = useState<(typeof STATUS_TABS)[number]['id']>('pending');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const operation = useOperation();
  const shown = requests.filter((request) => request.status === tab);

  const decide = async (request: StandbySwapView, decision: 'approve' | 'reject') => {
    const ok = await operation.run(() => standby.decide(request.id, decision, notes[request.id] ?? ''));
    if (ok) onChanged(decision === 'approve' ? 'Swap approved: the two places were exchanged and both people told.' : 'Swap rejected: the calendar is unchanged and the requester was told.');
  };
  const cancel = async (request: StandbySwapView) => {
    const ok = await operation.run(() => standby.cancel(request.id));
    if (ok) onChanged('Swap request withdrawn.');
  };

  return (
    <div data-testid="standby-requests">
      <Tabs
        tabs={STATUS_TABS.map((option) => ({
          id: option.id,
          label: option.label,
          badge: requests.filter((request) => request.status === option.id).length || undefined,
        }))}
        activeId={tab}
        onChange={(id) => setTab(id as typeof tab)}
        className="mb-4"
      />
      {operation.error !== null && (
        <p role="alert" className="mb-3 text-sm font-medium text-signal-600" data-testid="standby-request-error">
          {operation.error}
        </p>
      )}
      {shown.length === 0 ? (
        <EmptyState
          title={`No ${tab} swap requests`}
          description={canDecide ? 'Requests from technicians appear here.' : 'Requests you make, or that name you, appear here.'}
        />
      ) : (
        <ul className="space-y-3">
          {shown.map((request) => (
            <li key={request.id}>
              <Card data-testid="standby-request">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-steel-900">{request.kindLabel} swap</p>
                  <Badge tone={TONE[request.status]} size="sm">
                    {request.status[0]!.toUpperCase() + request.status.slice(1)}
                  </Badge>
                </div>
                <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                  <div className="rounded-md bg-steel-50 p-2.5">
                    <dt className="text-xs font-semibold uppercase tracking-wide text-steel-500">Requester</dt>
                    <dd className="font-medium text-steel-900">{request.requesterName}</dd>
                    <dd className="text-steel-700">
                      {weekRangeLabel(request.requesterWeekStart)} · {STANDBY_POSITION_LABELS[request.requesterPosition]}
                    </dd>
                  </div>
                  <div className="rounded-md bg-steel-50 p-2.5">
                    <dt className="text-xs font-semibold uppercase tracking-wide text-steel-500">Exchange with</dt>
                    <dd className="font-medium text-steel-900">{request.counterpartName}</dd>
                    <dd className="text-steel-700">
                      {weekRangeLabel(request.counterpartWeekStart)} · {STANDBY_POSITION_LABELS[request.counterpartPosition]}
                    </dd>
                  </div>
                </dl>
                <dl className="mt-3 grid gap-x-4 gap-y-1 text-sm text-steel-700 sm:grid-cols-[auto_1fr]">
                  <dt className="font-semibold">Reason</dt>
                  <dd>{request.reason.length > 0 ? request.reason : '—'}</dd>
                  <dt className="font-semibold">Submitted</dt>
                  <dd>{formatDateTime(request.requestedAt)}</dd>
                  {request.decidedAt !== null && (
                    <>
                      <dt className="font-semibold">{request.status === 'approved' ? 'Approved by' : 'Rejected by'}</dt>
                      <dd>
                        {request.decidedByName} · {formatDateTime(request.decidedAt)}
                      </dd>
                      <dt className="font-semibold">{request.status === 'rejected' ? 'Rejection reason' : 'Decision note'}</dt>
                      <dd>{request.decisionNote.length > 0 ? request.decisionNote : '—'}</dd>
                    </>
                  )}
                  {request.cancelledAt !== null && (
                    <>
                      <dt className="font-semibold">Withdrawn</dt>
                      <dd>{formatDateTime(request.cancelledAt)}</dd>
                    </>
                  )}
                </dl>

                {request.status === 'pending' && canDecide && (
                  <div className="mt-4 border-t border-steel-100 pt-3">
                    {!request.stillValid && (
                      <p className="mb-2 text-sm font-medium text-signal-700" data-testid="standby-request-stale">
                        The calendar changed after this request was made (or a week has started): it can only be rejected.
                      </p>
                    )}
                    <TextAreaField
                      label="Decision note (optional)"
                      rows={2}
                      maxLength={2000}
                      value={notes[request.id] ?? ''}
                      onChange={(event) => setNotes((current) => ({ ...current, [request.id]: event.target.value }))}
                      data-testid="standby-decision-note"
                    />
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button
                        variant="success"
                        onClick={() => void decide(request, 'approve')}
                        disabled={!request.stillValid || operation.running}
                        data-testid="standby-approve"
                      >
                        Approve swap
                      </Button>
                      <Button
                        variant="danger"
                        onClick={() => void decide(request, 'reject')}
                        disabled={operation.running}
                        data-testid="standby-reject"
                      >
                        Reject
                      </Button>
                    </div>
                  </div>
                )}
                {request.status === 'pending' && request.requesterId === meId && (
                  <div className="mt-4 border-t border-steel-100 pt-3">
                    <p className="mb-2 text-sm text-steel-600">Waiting for the office. Your standby weeks are unchanged until it is approved.</p>
                    <Button variant="secondary" onClick={() => void cancel(request)} disabled={operation.running} data-testid="standby-withdraw">
                      Withdraw request
                    </Button>
                  </div>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
