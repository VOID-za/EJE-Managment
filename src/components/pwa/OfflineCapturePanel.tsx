'use client';

import { useState } from 'react';
import { Button, Card, SelectField, TextAreaField, TextField } from '@/components/ui';
import { newIdempotencyKey } from '@/api/client';
import type { CachedJobDetail } from '@/lib/pwa/cached-job';
import {
  buildOfflineCapture,
  emptyOfflineCaptureFields,
  type OfflineCaptureFields,
  type OfflineCaptureKind,
} from '@/lib/pwa/offline-capture-forms';
import { canCaptureOffline } from '@/lib/pwa/offline-rules';
import { isPendingSupported, queueWork } from '@/lib/pwa/pending-work';
import { businessToday } from '@/lib/business-time';
import type { JobStatus } from '@/domain';

/**
 * HOLDING WORK AGAINST THE TABLET'S COPY OF A JOB. OFF-2, 27 October 2026.
 *
 * Shown on the offline page under the job the technician was standing at, and
 * only where the copy itself says capture is possible: the technician's own
 * job (only theirs is ever copied), in progress, not signed, written by a
 * build that recorded those facts. `canCaptureOffline` — the same rule the job
 * screen and the store apply — has the last word before anything is held, and
 * the server has the last word on the replay.
 *
 * Nothing here changes the copy on screen: a held capture is not on the job,
 * and the panel says so after every one.
 */
export const OfflineCapturePanel = ({
  detail,
  userId,
  onHeld,
}: {
  readonly detail: CachedJobDetail;
  readonly userId: string;
  readonly onHeld: () => void;
}) => {
  const [kind, setKind] = useState<OfflineCaptureKind | null>(null);
  const [fields, setFields] = useState<OfflineCaptureFields>(() =>
    emptyOfflineCaptureFields(businessToday()),
  );
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [message, setMessage] = useState<string | null>(null);

  // A copy from an older build carries neither fact: no capture rather than a guess.
  if (detail.signed === undefined || detail.capturesLabourAndTravel === undefined) return null;

  const context = {
    status: detail.status as JobStatus,
    mine: true,
    signed: detail.signed,
    observedAt: detail.capturedAt,
  };
  const verdict = canCaptureOffline('add_note', context);
  if (!verdict.allowed || !isPendingSupported()) {
    return (
      <Card className="p-4 text-sm text-slate-600 dark:text-slate-300">
        <p data-testid="offline-capture-unavailable">
          {verdict.reason ?? 'This tablet cannot hold work for later.'}
        </p>
      </Card>
    );
  }

  const kinds: readonly { readonly id: OfflineCaptureKind; readonly label: string }[] = [
    ...(detail.capturesLabourAndTravel
      ? ([
          { id: 'labour', label: 'Labour' },
          { id: 'travel', label: 'Travel' },
        ] as const)
      : []),
    { id: 'part', label: 'Part' },
    { id: 'note', label: 'Note' },
  ];

  const set = (key: keyof OfflineCaptureFields, value: string | boolean) =>
    setFields((current) => ({ ...current, [key]: value }));

  const hold = async (): Promise<void> => {
    if (kind === null) return;
    const built = buildOfflineCapture(kind, fields);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors({});
    try {
      await queueWork({
        userId,
        // The job's NUMBER: every job command accepts it, and the copy keeps no id.
        jobId: detail.jobNumber,
        jobNumber: detail.jobNumber,
        action: built.action,
        payload: built.payload,
        summary: built.summary,
        idempotencyKey: newIdempotencyKey(),
        context,
      });
      setMessage(`Held on this tablet — ${built.summary}. It is not on the job until the EJE server has it.`);
      setFields(emptyOfflineCaptureFields(businessToday()));
      setKind(null);
      onHeld();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'This tablet could not hold that capture.');
    }
  };

  return (
    <Card className="space-y-3 p-4">
      {/* The id is on this element because `Card` forwards only its own props. */}
      <div data-testid="offline-capture">
        <p className="text-sm font-semibold">Capture work on {detail.jobNumber} with no signal</p>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Held on this tablet and sent, oldest first, as soon as it can reach the EJE server. The
          server still decides whether it can go on the job.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {kinds.map((option) => (
          <Button
            key={option.id}
            type="button"
            size="sm"
            variant={kind === option.id ? 'primary' : 'secondary'}
            onClick={() => {
              setKind(option.id);
              setErrors({});
              setMessage(null);
            }}
          >
            {option.label}
          </Button>
        ))}
      </div>

      {(kind === 'labour' || kind === 'travel') && (
        <TextField label="Date" type="date" value={fields.date} error={errors.date} onChange={(event) => set('date', event.target.value)} />
      )}
      {kind === 'labour' && (
        <>
          <TextField label="Hours" inputMode="decimal" value={fields.hours} error={errors.hours} onChange={(event) => set('hours', event.target.value)} />
          <SelectField
            label="Rate"
            value={fields.rateType}
            error={errors.rateType}
            options={[
              { value: 'normal', label: 'Normal time' },
              { value: 'overtime', label: 'Overtime' },
              { value: 'double', label: 'Double time' },
            ]}
            onChange={(event) => set('rateType', event.target.value)}
          />
        </>
      )}
      {kind === 'travel' && (
        <TextField label="Kilometres" inputMode="decimal" value={fields.kilometres} error={errors.kilometres} onChange={(event) => set('kilometres', event.target.value)} />
      )}
      {kind === 'part' && (
        <>
          <TextField label="Part number" value={fields.partNumber} error={errors.partNumber} onChange={(event) => set('partNumber', event.target.value)} />
          <TextField label="Quantity" inputMode="numeric" value={fields.quantity} error={errors.quantity} onChange={(event) => set('quantity', event.target.value)} />
          <TextField label="Unit price (R)" inputMode="decimal" value={fields.unitPrice} error={errors.unitPrice} onChange={(event) => set('unitPrice', event.target.value)} />
        </>
      )}
      {(kind === 'labour' || kind === 'travel' || kind === 'part') && (
        <TextField label="Description (optional)" value={fields.description} error={errors.description} onChange={(event) => set('description', event.target.value)} />
      )}
      {kind === 'note' && (
        <>
          <TextAreaField label="Note" rows={4} value={fields.body} error={errors.body} onChange={(event) => set('body', event.target.value)} />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={fields.internal} onChange={(event) => set('internal', event.target.checked)} />
            Internal — for EJE only, not printed on the job card
          </label>
        </>
      )}
      {kind !== null && (
        <Button type="button" onClick={() => void hold()} data-testid="offline-capture-hold">
          Hold on this tablet
        </Button>
      )}
      {message !== null && (
        <p role="status" className="text-sm font-medium text-amber-900 dark:text-amber-200" data-testid="offline-capture-message">
          {message}
        </p>
      )}
    </Card>
  );
};
