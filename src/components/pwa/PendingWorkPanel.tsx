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
  answer_checklist: 'Checklist',
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
  const referred = rows.filter((row) => row.state === 'referred');

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
            {waiting.length > 0 && (conflicts.length > 0 || referred.length > 0) && ' '}
            {conflicts.length > 0 && (
              <>
                {conflicts.length} {conflicts.length === 1 ? 'was' : 'were'} refused by the server
                and {conflicts.length === 1 ? 'is' : 'are'} being passed to the office.
              </>
            )}
            {referred.length > 0 && (
              <>
                {' '}
                {referred.length} {referred.length === 1 ? 'is' : 'are'} with the office, who will
                decide what happens to {referred.length === 1 ? 'it' : 'them'}.
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
                {/*
                  WHICH OF THE FIVE THINGS THIS ROW IS. OFF-8.

                  "Not sent" covered two situations that need different things
                  of the technician: work waiting for a signal, and work whose
                  request is open right now. On a bad link with a dozen
                  captures, one spinner on the Send button read as nothing
                  happening at all — so the row that is moving says so.
                */}
                <Badge
                  tone={
                    row.state === 'conflict'
                      ? 'red'
                      : row.state === 'referred'
                        ? 'blue'
                        : pending.sending.includes(row.id)
                          ? 'blue'
                          : 'amber'
                  }
                  size="sm"
                >
                  {row.state === 'conflict'
                    ? 'Refused'
                    : row.state === 'referred'
                      ? 'With the office'
                      : pending.sending.includes(row.id)
                        ? 'Sending…'
                        : 'Not sent'}
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
                  The job changed while this tablet was away. This capture is being passed to the
                  office, who will decide what happens to it — your work is kept either way.
                </p>
              )}
              {row.state === 'referred' && (
                <p className="mt-1 text-xs text-steel-500">
                  The office has this capture and is deciding what happens to it. Nothing further
                  is sent from this tablet, and your work is not lost.
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
              {/*
                NO RETRY ON A REFERRED CAPTURE. The office has it, and a second
                attempt from here would either be refused again or race their
                decision. BD-15 stops the automatic replay; this stops the
                manual one.
              */}
              <Button type="button" variant="ghost" onClick={() => setDiscarding(row)}>
                {row.state === 'referred' ? 'Remove from tablet' : 'Discard'}
              </Button>
            </div>
          </li>
        ))}
      </ul>

      {pending.blockedBySession && (
        <p
          role="alert"
          data-testid="pending-session-blocked"
          className="mt-3 rounded-[var(--radius-control)] border border-amber-eje-200 bg-amber-eje-50 px-3 py-2 text-xs font-medium text-amber-eje-800"
        >
          Your session has ended, so nothing can be sent until you sign in again. The work above is
          kept on this tablet under your own name and nobody else can send it.
        </p>
      )}

      {pending.resolvedCount > 0 && (
        <p className="mt-3 text-xs text-steel-500" data-testid="pending-resolved-notice">
          The office has dealt with {pending.resolvedCount}{' '}
          {pending.resolvedCount === 1 ? 'capture' : 'captures'} referred from this tablet.
        </p>
      )}

      {!online && (
        <p className="mt-3 text-xs text-steel-500">
          This tablet has no connection. Everything above is kept until it does — closing the
          application or the battery going flat will not lose it.
        </p>
      )}

      <ConfirmDialog
        open={discarding !== null}
        title={
          discarding?.state === 'referred' ? 'Remove it from this tablet?' : 'Discard this capture?'
        }
        message={
          discarding?.state === 'referred' ? (
            <>
              <p>
                <span className="font-semibold">{discarding.summary}</span> is with the office,
                which has its own record of it.
              </p>
              <p className="mt-2 text-steel-500">
                This only removes it from your tablet. The office&rsquo;s copy, and whatever they
                decide, are unaffected.
              </p>
            </>
          ) : (
            <>
              <p>
                <span className="font-semibold">{discarding?.summary}</span> has not reached the
                EJE server, and this tablet is the only place it exists.
              </p>
              <p className="mt-2 text-steel-500">
                Discarding it loses it for good. If the work was really done, capture it again once
                the job allows it, or tell the office.
              </p>
            </>
          )
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
