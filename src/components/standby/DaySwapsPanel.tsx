'use client';

import { useState } from 'react';
import type { DaySwapView } from '@/application/standby-days';
import { Badge, Button, Card, TextField } from '@/components/ui';
import { standby } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';
import { formatDateTime } from '@/lib/format';

/**
 * DAY SWAPS AND THEIR TWO STAGES. STANDBY-DAY-1 (2 November 2026).
 *
 * The person asked approves or denies; then the Office approves or rejects;
 * the requester may withdraw until the person asked has answered. Each shows
 * where it stands — the other person's answer and the Office's — and nothing
 * pending is shown as a change made.
 */
const TONE: Record<DaySwapView['status'], 'amber' | 'blue' | 'green' | 'red' | 'neutral'> = {
  awaiting_recipient: 'amber',
  awaiting_office: 'blue',
  approved: 'green',
  denied: 'red',
  rejected: 'red',
  withdrawn: 'neutral',
};

const DaySwapRow = ({ swap, onChanged }: { readonly swap: DaySwapView; readonly onChanged: (message: string) => void }) => {
  const operation = useOperation();
  const [note, setNote] = useState('');
  const act = async (run: () => Promise<unknown>, message: string) => {
    const ok = await operation.run(run);
    if (ok) onChanged(message);
  };
  const live = swap.status === 'awaiting_recipient' || swap.status === 'awaiting_office';
  return (
    <div data-testid="day-swap-request" data-status={swap.status} data-swap={swap.id}>
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-steel-900">
          {swap.requesterName} ⇄ {swap.recipientName} <span className="font-normal text-steel-500">· {swap.kindLabel}</span>
        </p>
        <Badge tone={TONE[swap.status]} size="sm">{swap.statusLabel}</Badge>
      </div>
      <ul className="mt-2 space-y-1 text-sm text-steel-800" data-testid="day-swap-pairs">
        {swap.pairLabels.map((label) => (
          <li key={label}>{label}</li>
        ))}
      </ul>
      {swap.reason.length > 0 && <p className="mt-2 text-xs text-steel-600">Reason: {swap.reason}</p>}
      <dl className="mt-2 grid gap-1 text-xs text-steel-600 sm:grid-cols-2">
        <div>
          <dt className="inline font-medium">{swap.recipientName}: </dt>
          <dd className="inline" data-testid="day-swap-recipient-status">
            {swap.recipientDecidedAt === null
              ? swap.status === 'withdrawn' ? 'not asked any more' : 'not answered yet'
              : `${swap.status === 'denied' ? 'denied' : 'approved'} ${formatDateTime(swap.recipientDecidedAt)}`}
            {swap.recipientNote.length > 0 ? ` — ${swap.recipientNote}` : ''}
          </dd>
        </div>
        <div>
          <dt className="inline font-medium">Office: </dt>
          <dd className="inline" data-testid="day-swap-office-status">
            {swap.officeDecidedAt === null
              ? swap.status === 'awaiting_office' ? 'waiting for a decision' : '—'
              : `${swap.status === 'approved' ? 'approved' : 'rejected'} by ${swap.officeDecidedByName ?? 'the Office'} ${formatDateTime(swap.officeDecidedAt)}`}
            {swap.officeNote.length > 0 ? ` — ${swap.officeNote}` : ''}
          </dd>
        </div>
      </dl>
      {live && !swap.stillValid && (
        <p role="status" className="mt-2 text-sm text-signal-600" data-testid="day-swap-stale">
          A day in this swap has changed or started, so it can no longer be approved.
        </p>
      )}
      {(swap.canAnswer || swap.canDecide) && (
        <div className="mt-3">
          <TextField label="Note (optional)" value={note} onChange={(event) => setNote(event.target.value)} data-testid="day-swap-note" />
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {swap.canAnswer && (
          <>
            <Button disabled={!swap.stillValid} loading={operation.running} onClick={() => void act(() => standby.answerDaySwap(swap.id, 'approve', note), 'You approved the swap. It now waits for the Office; nothing has changed yet.')} data-testid="day-swap-approve">
              Approve
            </Button>
            <Button variant="secondary" loading={operation.running} onClick={() => void act(() => standby.answerDaySwap(swap.id, 'deny', note), 'You declined the swap. Nothing changed.')} data-testid="day-swap-deny">
              Deny
            </Button>
          </>
        )}
        {swap.canDecide && (
          <>
            <Button disabled={!swap.stillValid} loading={operation.running} onClick={() => void act(() => standby.decideDaySwap(swap.id, 'approve', note), 'Swap approved: only those days changed on the calendar.')} data-testid="day-swap-office-approve">
              Approve swap
            </Button>
            <Button variant="secondary" loading={operation.running} onClick={() => void act(() => standby.decideDaySwap(swap.id, 'reject', note), 'Swap rejected. Nothing changed.')} data-testid="day-swap-office-reject">
              Reject
            </Button>
          </>
        )}
        {swap.canWithdraw && (
          <Button variant="ghost" loading={operation.running} onClick={() => void act(() => standby.withdrawDaySwap(swap.id), 'Swap request withdrawn.')} data-testid="day-swap-withdraw">
            Withdraw
          </Button>
        )}
      </div>
      {operation.error !== null && (
        <p role="alert" className="mt-2 text-sm font-medium text-signal-600" data-testid="day-swap-request-error">
          {operation.error}
        </p>
      )}
    </Card>
    </div>
  );
};

export const DaySwapsPanel = ({ swaps, onChanged }: { readonly swaps: readonly DaySwapView[]; readonly onChanged: (message: string) => void }) => (
  <section className="space-y-3" data-testid="day-swaps">
    <h2 className="text-sm font-semibold text-steel-900">Day swaps</h2>
    {swaps.length === 0 ? (
      <p className="text-sm text-steel-600">No day swaps yet.</p>
    ) : (
      swaps.map((swap) => <DaySwapRow key={swap.id} swap={swap} onChanged={onChanged} />)
    )}
  </section>
);
