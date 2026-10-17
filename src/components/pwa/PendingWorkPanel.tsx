'use client';

import { useState } from 'react';
import { Badge, Button, Card, ConfirmDialog, Icon } from '@/components/ui';
import { useOnline } from '@/hooks/useOnline';
import type { PendingWorkResult } from '@/hooks/usePendingWork';
import type { PendingWork } from '@/lib/pwa/pending-work';
import { formatRelative } from '@/lib/format';

const ACTION_LABEL: Readonly<Record<string, string>> = {
  add_labour: 'Labour',
  add_travel: 'Travel',
  add_part: 'Part',
  add_note: 'Note',
};

/**
 * WHAT THIS TABLET IS HOLDING, AND WHAT THE SERVER HAS REFUSED. OFF-8, OFF-9.
 *
 * The panel exists because of one question a technician must never have to
 * guess the answer to: is the work I captured on the job? Every row here says
 * which of three things is true — waiting to be sent, refused by the server, or
 * (by being absent) on the job. There is no fourth state and nothing is
 * implied by silence.
 *
 * A REFUSAL IS SHOWN IN THE SERVER'S OWN WORDS. The server refuses queued work
 * because something real changed: the customer signed, the office closed or
 * cancelled the job, it was reassigned, or the session is over. Paraphrasing
 * that into "sync failed" would hide the only information that tells the
 * technician what to do next.
 *
 * NOTHING IS DISCARDED ON THEIR BEHALF. Discarding is an explicit, confirmed
 * action on a row they can see, and the dialog says the work will be lost,
 * because it will be — there is nowhere else it exists. That is CR-02's
 * promise kept at the one place it could be broken.
 */
export const PendingWorkPanel = ({
  pending,
  jobId,
  className,
}: {
  readonly pending: PendingWorkResult;
  /** When set, only this job's captures are shown. */
  readonly jobId?: string;
  readonly className?: string;
}) => {
  const online = useOnline();
  const [discarding, setDiscarding] = useState<PendingWork | null>(null);

  const rows = jobId === undefined ? pending.rows : pending.rows.filter((row) => row.jobId === jobId);
  if (rows.length === 0) return null;

  const waiting = rows.filter((row) => row.state === 'pending');
  const conflicts = rows.filter((row) => row.state === 'conflict');

  return (
    <Card className={className}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3
            className="flex items-center gap-2 text-sm font-semibold text-steel-900"
            data-testid="pending-work-heading"
          >
            <Icon name="clock" className="size-4 text-amber-eje-600" />
            Work waiting to be sent
          </h3>
          <p className="mt-0.5 text-sm text-steel-500">
            {waiting.length > 0 && (
              <>
                {waiting.length} {waiting.length === 1 ? 'capture is' : 'captures are'} held on
                this tablet and <strong className="font-semibold">not on the server</strong>.
              </>
            )}
            {waiting.length > 0 && conflicts.length > 0 && ' '}
            {conflicts.length > 0 && (
              <>
                {conflicts.length} {conflicts.length === 1 ? 'was' : 'were'} refused by the server
                and {conflicts.length === 1 ? 'needs' : 'need'} a decision.
              </>
            )}
          </p>
        </div>
        {waiting.length > 0 && (
          <Button
            type="button"
            onClick={() => void pending.flush()}
            loading={pending.flushing}
            disabled={!online}
            data-testid="pending-work-send"
          >
            {online ? 'Send now' : 'No connection'}
          </Button>
        )}
      </div>

      <ul className="mt-4 divide-y divide-steel-100" data-testid="pending-work-list">
        {rows.map((row) => (
          <li key={row.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={row.state === 'conflict' ? 'red' : 'amber'} size="sm">
                  {row.state === 'conflict' ? 'Refused' : 'Not sent'}
                </Badge>
                <span className="text-xs font-semibold tracking-wide text-steel-500 uppercase">
                  {ACTION_LABEL[row.action] ?? row.action}
                </span>
                {jobId === undefined && (
                  <span className="font-mono text-xs text-steel-500">{row.jobNumber}</span>
                )}
              </div>
              <p className="mt-1 text-sm font-medium text-steel-900">{row.summary}</p>
              <p className="text-xs text-steel-400">
                Captured {formatRelative(row.capturedAt)}
                {row.attempts > 0 && ` · ${row.attempts} ${row.attempts === 1 ? 'attempt' : 'attempts'}`}
              </p>
              {row.state === 'conflict' && row.lastError !== null && (
                <p className="mt-1 text-sm font-medium text-signal-700">{row.lastError}</p>
              )}
              {row.state === 'conflict' && (
                <p className="mt-1 text-xs text-steel-500">
                  The job changed while this tablet was away. Read what the server said, then
                  either try again — if whatever blocked it has been resolved — or discard this
                  capture and raise it with the office. Nothing is sent until you choose.
                </p>
              )}
            </div>
            <div className="flex shrink-0 gap-2">
              {row.state === 'conflict' && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void pending.retry(row.id)}
                  loading={pending.flushing}
                  disabled={!online}
                >
                  Try again
                </Button>
              )}
              <Button type="button" variant="ghost" onClick={() => setDiscarding(row)}>
                Discard
              </Button>
            </div>
          </li>
        ))}
      </ul>

      {!online && (
        <p className="mt-3 text-xs text-steel-500">
          This tablet has no connection. Everything above is kept until it does — closing the
          application or the battery going flat will not lose it.
        </p>
      )}

      <ConfirmDialog
        open={discarding !== null}
        title="Discard this capture?"
        message={
          <>
            <p>
              <span className="font-semibold">{discarding?.summary}</span> has not reached the EJE
              server, and this tablet is the only place it exists.
            </p>
            <p className="mt-2 text-steel-500">
              Discarding it loses it for good. If the work was really done, capture it again once
              the job allows it, or tell the office.
            </p>
          </>
        }
        confirmLabel="Discard the capture"
        confirmVariant="danger"
        onConfirm={() => {
          const row = discarding;
          setDiscarding(null);
          if (row !== null) void pending.discard(row.id);
        }}
        onCancel={() => setDiscarding(null)}
      />
    </Card>
  );
};
