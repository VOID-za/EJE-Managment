'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { canAcceptJob, checkReadyForSignature, type Job } from '@/domain';
import {
  acceptJob,
  moveToAwaitingSpares,
  returnToInProgress,
  startCompletion,
  startSignature,
} from '@/application/job-operations';
import { Button, ConfirmDialog, Icon, Modal, TextAreaField } from '@/components/ui';
import { useOperation } from '@/hooks/useOperation';
import { RuleViolationNotice } from './RuleViolationNotice';

/**
 * The single place that decides which workflow action is available on a job.
 * Availability comes from the domain state machine, and every transition is
 * confirmed before it is applied.
 */
export const JobActionBar = ({
  job,
  onChanged,
}: {
  readonly job: Job;
  readonly onChanged: () => void;
}) => {
  const router = useRouter();
  const operation = useOperation();
  const [confirmAccept, setConfirmAccept] = useState(false);
  const [sparesOpen, setSparesOpen] = useState(false);
  const [sparesReason, setSparesReason] = useState('');
  const [confirmResume, setConfirmResume] = useState(false);

  const signatureReadiness = checkReadyForSignature(job);

  const actions: React.ReactNode[] = [];

  if (canAcceptJob(job)) {
    actions.push(
      <Button
        key="accept"
        size="lg"
        onClick={() => setConfirmAccept(true)}
        leadingIcon={<Icon name="check" className="size-5" />}
      >
        Accept job
      </Button>,
    );
  }

  if (job.status === 'in_progress') {
    actions.push(
      <Button
        key="spares"
        size="lg"
        variant="secondary"
        onClick={() => setSparesOpen(true)}
        leadingIcon={<Icon name="box" className="size-5" />}
      >
        Awaiting spares
      </Button>,
      <Button
        key="complete"
        size="lg"
        onClick={async () => {
          const ok = await operation.run((context) => startCompletion(context, job));
          if (ok) onChanged();
        }}
        loading={operation.running}
        leadingIcon={<Icon name="wrench" className="size-5" />}
      >
        Complete job
      </Button>,
    );
  }

  if (job.status === 'awaiting_spares') {
    actions.push(
      <Button
        key="resume"
        size="lg"
        onClick={() => setConfirmResume(true)}
        leadingIcon={<Icon name="refresh" className="size-5" />}
      >
        Resume job
      </Button>,
    );
  }

  if (job.status === 'completion') {
    actions.push(
      <Button
        key="sign"
        size="lg"
        disabled={!signatureReadiness.allowed}
        onClick={async () => {
          const ok = await operation.run((context) => startSignature(context, job));
          if (ok) router.push(`/jobs/${job.jobNumber}/sign`);
        }}
        loading={operation.running}
        leadingIcon={<Icon name="signature" className="size-5" />}
      >
        Customer signature
      </Button>,
    );
  }

  if (job.status === 'customer_signature') {
    actions.push(
      <Button
        key="sign-continue"
        size="lg"
        onClick={() => router.push(`/jobs/${job.jobNumber}/sign`)}
        leadingIcon={<Icon name="signature" className="size-5" />}
      >
        Capture signature
      </Button>,
    );
  }

  if (job.status === 'review') {
    actions.push(
      <Button
        key="review"
        size="lg"
        onClick={() => router.push(`/jobs/${job.jobNumber}/review`)}
        leadingIcon={<Icon name="document" className="size-5" />}
      >
        Review job card
      </Button>,
    );
  }

  if (actions.length === 0 && operation.error === null) return null;

  return (
    <div className="space-y-3">
      {job.status === 'completion' && !signatureReadiness.allowed && (
        <RuleViolationNotice
          title="Outstanding before the customer can sign"
          violations={signatureReadiness.violations}
        />
      )}

      {operation.error !== null && (
        <RuleViolationNotice
          title="This step could not be completed"
          message={operation.error}
          violations={operation.violations}
        />
      )}

      {actions.length > 0 && <div className="flex flex-wrap gap-2">{actions}</div>}

      <ConfirmDialog
        open={confirmAccept}
        title="Accept this job?"
        message={
          <>
            <p>
              Accepting <span className="font-semibold">{job.jobNumber}</span> assigns it to you and
              moves it straight to <span className="font-semibold">In Progress</span>.
            </p>
            <p className="mt-2 text-steel-500">
              There is no separate start step — the job is live from the moment you accept it.
            </p>
          </>
        }
        confirmLabel="Accept and start"
        busy={operation.running}
        onConfirm={async () => {
          const ok = await operation.run((context) => acceptJob(context, job));
          setConfirmAccept(false);
          if (ok) onChanged();
        }}
        onCancel={() => setConfirmAccept(false)}
      />

      <ConfirmDialog
        open={confirmResume}
        title="Resume this job?"
        message={`${job.jobNumber} will move back to In Progress and work can be captured against it again.`}
        confirmLabel="Resume job"
        busy={operation.running}
        onConfirm={async () => {
          const ok = await operation.run((context) => returnToInProgress(context, job));
          setConfirmResume(false);
          if (ok) onChanged();
        }}
        onCancel={() => setConfirmResume(false)}
      />

      <Modal
        open={sparesOpen}
        title="Move to Awaiting Spares"
        description="Record why the job is blocked. The reason appears on the job and in the activity trail."
        onClose={() => setSparesOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setSparesOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={operation.running}
              disabled={sparesReason.trim().length === 0}
              onClick={async () => {
                const ok = await operation.run((context) =>
                  moveToAwaitingSpares(context, job, sparesReason.trim()),
                );
                if (ok) {
                  setSparesOpen(false);
                  setSparesReason('');
                  onChanged();
                }
              }}
            >
              Move to Awaiting Spares
            </Button>
          </>
        }
      >
        <TextAreaField
          label="Reason"
          required
          rows={4}
          value={sparesReason}
          onChange={(event) => setSparesReason(event.target.value)}
          placeholder="e.g. Replacement IGBT module on back-order from the supplier, ETA next week."
          hint="A job may move in and out of Awaiting Spares as many times as needed."
        />
      </Modal>
    </div>
  );
};
