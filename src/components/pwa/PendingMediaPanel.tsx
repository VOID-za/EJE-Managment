'use client';

import { useState } from 'react';
import { Badge, Button, Card, ConfirmDialog, Icon } from '@/components/ui';
import { useOnline } from '@/hooks/useOnline';
import type { PendingMediaResult } from '@/hooks/usePendingMedia';
import { heldMediaSummary, type PendingMedia } from '@/lib/pwa/pending-media';
import { formatFileSize, formatRelative } from '@/lib/format';
import { SYNC_LABEL, SYNC_TONE, syncStateOf } from '@/lib/pwa/sync-state';

const DESTINATION_LABEL: Readonly<Record<PendingMedia['destination']['kind'], string>> = {
  job_photo: 'Job photo',
  checklist_evidence: 'Checklist evidence',
  machine_photo: 'Machine photo',
};

/**
 * THE PHOTOGRAPHS THIS TABLET IS HOLDING. OFF-MEDIA-1.
 *
 * The same panel, the same three states and the same promises as
 * `PendingWorkPanel` — waiting, refused, or gone because the server has it —
 * because a technician should not have to learn a second mental model for
 * "this is on the tablet, not on the job".
 *
 * IT SAYS HOW MUCH IS HELD, which the capture queue does not need to. These
 * rows are megabytes, the device has a stated ceiling, and a technician who is
 * about to photograph twenty things needs to know how close to it they are
 * BEFORE the capture that gets refused.
 *
 * A REFUSAL IS SHOWN IN THE SERVER'S OWN WORDS, and nothing is discarded on
 * their behalf: discarding is an explicit confirmed action, and the dialog says
 * the photograph will be lost, because it will be — there is nowhere else it
 * exists.
 */
export const PendingMediaPanel = ({
  media,
  jobId,
  className,
}: {
  readonly media: PendingMediaResult;
  /** When set, only this job's photographs are shown. */
  readonly jobId?: string;
  readonly className?: string;
}) => {
  const online = useOnline();
  const [discarding, setDiscarding] = useState<PendingMedia | null>(null);

  const rows = jobId === undefined ? media.rows : media.rows.filter((row) => row.jobId === jobId);
  if (rows.length === 0) return null;

  const held = heldMediaSummary(rows);
  const waiting = rows.filter((row) => row.state === 'pending');
  const conflicts = rows.filter((row) => row.state === 'conflict');

  return (
    <Card className={className}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3
            className="flex items-center gap-2 text-sm font-semibold text-steel-900"
            data-testid="pending-media-heading"
          >
            <Icon name="camera" className="size-4 text-amber-eje-600" />
            {held.count} {held.count === 1 ? 'photograph' : 'photographs'} on this tablet
            <span className="text-xs font-normal text-steel-500">
              ({formatFileSize(held.bytes)})
            </span>
          </h3>
          <p className="mt-1 text-sm text-steel-500">
            {conflicts.length > 0
              ? `${conflicts.length} ${conflicts.length === 1 ? 'was refused by the server and needs' : 'were refused by the server and need'} a decision.`
              : 'Not on the job yet. They are sent when there is a signal, and they stay under your name until then.'}
          </p>
        </div>
        {waiting.length > 0 && online && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            loading={media.sending}
            onClick={() => void media.flush()}
            data-testid="pending-media-send"
          >
            Send now
          </Button>
        )}
      </div>

      <ul className="mt-4 divide-y divide-steel-100" data-testid="pending-media-list">
        {rows.map((row) => (
          <li key={row.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                {/* OFF-8: the same five names the capture queue uses. */}
                <Badge
                  tone={SYNC_TONE[syncStateOf({ state: row.state, sending: media.sending, online })]}
                  size="sm"
                >
                  {SYNC_LABEL[syncStateOf({ state: row.state, sending: media.sending, online })]}
                </Badge>
                <span className="text-xs font-semibold tracking-wide text-steel-500 uppercase">
                  {DESTINATION_LABEL[row.destination.kind]}
                </span>
                {jobId === undefined && (
                  <span className="font-mono text-xs text-steel-500">{row.jobNumber}</span>
                )}
              </div>
              <p className="mt-1 text-sm font-medium text-steel-900">
                {row.caption.length > 0 ? row.caption : row.fileName}
              </p>
              <p className="text-xs text-steel-400">
                {formatFileSize(row.sizeBytes)} · taken {formatRelative(row.capturedAt)}
                {row.attempts > 0 &&
                  ` · ${row.attempts} ${row.attempts === 1 ? 'attempt' : 'attempts'}`}
              </p>
              {row.state === 'conflict' && row.lastError !== null && (
                <p className="mt-1 text-sm font-medium text-signal-700">{row.lastError}</p>
              )}
            </div>
            <div className="flex shrink-0 gap-2">
              {row.state === 'conflict' && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void media.retry(row.id)}
                  loading={media.sending}
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

      {media.blockedBySession && (
        <p
          role="alert"
          data-testid="pending-media-session-blocked"
          className="mt-3 rounded-[var(--radius-control)] border border-amber-eje-200 bg-amber-eje-50 px-3 py-2 text-xs font-medium text-amber-eje-800"
        >
          Your session has ended, so nothing can be sent until you sign in again. The photographs
          above are kept on this tablet under your own name and nobody else can send them.
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
        title="Discard this photograph?"
        message={
          <>
            <p>
              {discarding?.caption.length ?? 0 > 0 ? discarding?.caption : discarding?.fileName} has
              never reached the EJE server, so there is no other copy of it.
            </p>
            <p className="mt-2 text-steel-500">
              If it is evidence of something you cannot photograph again, send it instead.
            </p>
          </>
        }
        confirmLabel="Discard the photograph"
        confirmVariant="danger"
        onConfirm={() => {
          const row = discarding;
          setDiscarding(null);
          if (row !== null) void media.discard(row.id);
        }}
        onCancel={() => setDiscarding(null)}
      />
    </Card>
  );
};
