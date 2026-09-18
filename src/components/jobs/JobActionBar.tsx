'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  canAcceptJob,
  canCancelJob,
  canDeleteJob,
  canTransferJob,
  checkReadyForSignature,
} from '@/domain';
import {
  moveToAwaitingSpares,
  returnToInProgress,
  startCompletion,
  startSignature,
} from '@/application/job-operations';
import type { JobView } from '@/application/job-view';
import { Button, ConfirmDialog, Icon, Modal, TextAreaField } from '@/components/ui';
import { useOperation } from '@/hooks/useOperation';
import { useCurrentUser } from '@/providers/AppProvider';
import { RuleViolationNotice } from './RuleViolationNotice';
import { AcceptJobFlow } from './AcceptJobFlow';
import { CancelJobDialog } from './CancelJobDialog';
import { TransferJobDialog } from './TransferJobDialog';

/**
 * The single place that decides which workflow action is available on a job.
 * Availability comes from the domain state machine, and every transition is
 * confirmed before it is applied.
 */
export const JobActionBar = ({
  view,
  onChanged,
}: {
  readonly view: JobView;
  readonly onChanged: () => void;
}) => {
  const { job } = view;
  const router = useRouter();
  const operation = useOperation();
  const currentUser = useCurrentUser();
  const [confirmAccept, setConfirmAccept] = useState(false);
  const [sparesOpen, setSparesOpen] = useState(false);
  const [sparesReason, setSparesReason] = useState('');
  const [confirmResume, setConfirmResume] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [ending, setEnding] = useState<'cancel' | 'delete' | null>(null);

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
        Review &amp; submit job card
      </Button>,
    );
  }

  /*
   * Issued, and waiting on the customer's copy reaching them.
   *
   * There is an action here on purpose: the job is not finished, and whoever
   * opens it needs somewhere to go — the review screen carries the delivery
   * state and the re-send.
   */
  if (job.status === 'awaiting_delivery') {
    actions.push(
      <Button
        key="delivery"
        size="lg"
        variant="secondary"
        onClick={() => router.push(`/jobs/${job.jobNumber}/review`)}
        leadingIcon={<Icon name="mail" className="size-5" />}
      >
        {job.delivery?.state === 'failed'
          ? 'Delivery failed — re-send'
          : 'Awaiting delivery confirmation'}
      </Button>,
    );
  }

  // Historical Master Review: the office corrects the job card, then issues it.
  if (job.status === 'submitted') {
    actions.push(
      <Button
        key="master-review"
        size="lg"
        variant={currentUser.role === 'master' ? 'primary' : 'secondary'}
        disabled={currentUser.role !== 'master'}
        onClick={() => router.push(`/jobs/${job.jobNumber}/review`)}
        leadingIcon={<Icon name="document" className="size-5" />}
      >
        {currentUser.role === 'master' ? 'Review & submit job card' : 'With the office for review'}
      </Button>,
    );
  }

  // Handing a job on is a secondary action: available whenever the job is
  // transferable, and never competing with the primary step for attention.
  if (canTransferJob(currentUser, job)) {
    actions.push(
      <Button
        key="transfer"
        size="lg"
        variant="secondary"
        onClick={() => setTransferring(true)}
        leadingIcon={<Icon name="user" className="size-5" />}
      >
        Transfer job
      </Button>,
    );
  }

  // Cancel and delete are Master-only and deliberately separate: a real job
  // that will not happen versus one that should never have existed.
  if (canCancelJob(currentUser.role, job.status)) {
    actions.push(
      <Button
        key="cancel"
        size="lg"
        variant="ghost"
        onClick={() => setEnding('cancel')}
        leadingIcon={<Icon name="close" className="size-5" />}
      >
        Cancel job
      </Button>,
    );
  }

  if (canDeleteJob(currentUser.role, job)) {
    actions.push(
      <Button
        key="delete"
        size="lg"
        variant="ghost"
        onClick={() => setEnding('delete')}
        leadingIcon={<Icon name="trash" className="size-5" />}
      >
        Delete job
      </Button>,
    );
  }

  if (actions.length === 0 && operation.error === null && !confirmAccept) {
    return null;
  }

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

      {/* Acceptance and the site-location offer live in one component used by
          every acceptance action, so the prompt appears exactly once and
          behaves the same wherever it started. */}
      <AcceptJobFlow
        jobNumber={job.jobNumber}
        view={view}
        open={confirmAccept}
        onClose={() => setConfirmAccept(false)}
        onAccepted={onChanged}
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

      {transferring && (
        <TransferJobDialog
          job={job}
          technicians={view.users.filter((candidate) => candidate.role === 'technician')}
          onClose={() => setTransferring(false)}
          onTransferred={() => {
            setTransferring(false);
            onChanged();
          }}
        />
      )}

      {ending !== null && (
        <CancelJobDialog
          job={job}
          mode={ending}
          onClose={() => setEnding(null)}
          onDone={() => {
            setEnding(null);
            // A deleted job no longer belongs on its own page; a cancelled one
            // still does, with its CANCELLED banner.
            if (ending === 'delete') router.push('/jobs');
            else onChanged();
          }}
        />
      )}
    </div>
  );
};
