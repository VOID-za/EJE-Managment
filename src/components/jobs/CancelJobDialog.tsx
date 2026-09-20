'use client';

import { jobs } from '@/api/endpoints';
import { useState } from 'react';
import {
  CANCELLATION_REASONS,
  cancellationReasonLabel,
  type CancellationReason,
  type Job,
} from '@/domain';
import { Button, Modal, SelectField, TextAreaField } from '@/components/ui';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';
import { useOperation } from '@/hooks/useOperation';

/**
 * Cancel or delete a job.
 *
 * One component for two deliberately different actions, because the thing a
 * Master most needs is to understand which one they are doing. Cancelling keeps
 * a real request that will not happen; deleting removes a job that should never
 * have existed. The wording in each mode says so, and neither destroys the
 * record or the audit trail.
 */
export const CancelJobDialog = ({
  job,
  mode,
  onClose,
  onDone,
}: {
  readonly job: Job;
  readonly mode: 'cancel' | 'delete';
  readonly onClose: () => void;
  readonly onDone: () => void;
}) => {
  const operation = useOperation();
  const [reason, setReason] = useState<CancellationReason>('customer_resolved');
  const [description, setDescription] = useState('');

  const submit = async (): Promise<void> => {
    const ok = await operation.run(() =>
      mode === 'cancel'
        ? jobs.cancel(job.id, { reason, description })
        : jobs.remove(job.id, description),
    );
    if (ok) onDone();
  };

  return (
    <Modal
      open
      title={mode === 'cancel' ? `Cancel ${job.jobNumber}?` : `Delete ${job.jobNumber}?`}
      description={
        mode === 'cancel'
          ? 'For a real job that will not happen. The job keeps everything it recorded and stays searchable.'
          : 'For a job that should never have existed — a duplicate, or the wrong customer.'
      }
      onClose={onClose}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={operation.running}>
            Keep the job
          </Button>
          <Button
            variant="danger"
            onClick={submit}
            loading={operation.running}
            disabled={mode === 'delete' && description.trim().length === 0}
          >
            {mode === 'cancel' ? 'Cancel job' : 'Delete job'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {operation.error !== null && (
          <RuleViolationNotice
            title={mode === 'cancel' ? 'The job was not cancelled' : 'The job was not deleted'}
            message={operation.error}
            violations={operation.violations}
          />
        )}

        {mode === 'cancel' ? (
          <>
            <SelectField
              label="Reason"
              required
              value={reason}
              onChange={(event) => setReason(event.target.value as CancellationReason)}
              options={CANCELLATION_REASONS.map((candidate) => ({
                value: candidate,
                label: cancellationReasonLabel(candidate),
              }))}
            />
            <TextAreaField
              label="Description"
              required={reason === 'other'}
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              hint={
                reason === 'other'
                  ? 'Required when the reason is Other.'
                  : 'Optional. Worth adding — six months from now the reason alone may not be enough.'
              }
            />
          </>
        ) : (
          <TextAreaField
            label="Why should this job not exist?"
            required
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="e.g. Duplicate of EJE-1058 — raised twice by mistake."
            hint="Recorded on the audit trail so the job can be accounted for later."
          />
        )}

        <p className="rounded-[var(--radius-control)] border border-amber-eje-200 bg-amber-eje-50 px-3 py-2.5 text-xs text-amber-eje-700">
          {mode === 'cancel'
            ? 'The job leaves the active lists and the calendar, and is marked CANCELLED. It stays searchable and keeps its full history.'
            : 'The job is removed from every active list and the calendar. The record and its audit trail are retained, and it remains findable by search.'}
        </p>
      </div>
    </Modal>
  );
};
