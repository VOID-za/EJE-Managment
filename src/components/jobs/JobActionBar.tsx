'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  can,
  canAcceptJob,
  canCancelJob,
  canDeleteJob,
  canSubmitJobCard,
  canTransferJob,
  checkReadyForSignature,
  checkReadyForSubmission,
  refusalAwaitingResolution,
} from '@/domain';
import type { JobView } from '@/application/job-view';
import { Button, ConfirmDialog, Icon, Modal, TextAreaField } from '@/components/ui';
import { jobs } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';
import { useCurrentUser } from '@/providers/AppProvider';
import { RuleViolationNotice } from './RuleViolationNotice';
import { AcceptJobFlow } from './AcceptJobFlow';
import { SubmitJobCardDialog, submissionBlocker } from './SubmitJobCardDialog';
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
  onCompleteJob,
}: {
  readonly view: JobView;
  readonly onChanged: () => void;
  /** Opens the guided close-out. The job screen owns the wizard. */
  readonly onCompleteJob: () => void;
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
  const [submitting, setSubmitting] = useState(false);
  const [ending, setEnding] = useState<'cancel' | 'delete' | null>(null);

  const signatureReadiness = checkReadyForSignature(job);

  const actions: React.ReactNode[] = [];

  if (canAcceptJob(job, currentUser)) {
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
          /*
           * Move the job into Completion, THEN open the wizard.
           *
           * The status change is the same operation as before — the wizard is
           * not a second workflow — but it is no longer the whole of what the
           * button does. Closing a job is a sequence, and this is where it
           * starts.
           */
          const ok = await operation.run(() => jobs.startCompletion(job.id));
          if (ok) {
            onChanged();
            onCompleteJob();
          }
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

  // Both of these are the close-out already under way, so they return to the
  // wizard rather than dropping the technician onto a page in the middle of it.
  if (job.status === 'completion') {
    actions.push(
      <Button
        key="complete-continue"
        size="lg"
        onClick={onCompleteJob}
        leadingIcon={<Icon name="wrench" className="size-5" />}
      >
        Continue completing
      </Button>,
    );
  }

  if (job.status === 'customer_signature') {
    actions.push(
      <Button
        key="sign-continue"
        size="lg"
        onClick={onCompleteJob}
        leadingIcon={<Icon name="signature" className="size-5" />}
      >
        Capture signature
      </Button>,
    );
  }

  if (job.status === 'review') {
    /*
     * TWO DIFFERENT JOBS SHARE THIS STATUS, and they are not offered the same
     * things. A signature and a refusal both land at `review`; what tells them
     * apart is whether there is a refusal still awaiting the office.
     */
    const awaitingResolution = refusalAwaitingResolution(job);

    if (awaitingResolution) {
      /*
       * A REFUSED JOB CARD IS THE OFFICE'S. THE TECHNICIAN IS READ-ONLY.
       * MASTER SCOPE REF-11, REF-12.
       *
       * "The technician may ONLY view the submitted job card and its refusal
       * information" — no Capture signature, no Return for signature, no
       * Submit, no Resolve refusal, no Without customer signature. The server
       * refuses all of them; this stops the screen advertising what it will
       * not honour. The refusal panel above the action bar still shows the
       * technician the reason, which is the part they are meant to see.
       */
      const office = can(currentUser.role, 'jobs.resolveSignatureRefusal');

      /*
       * The office's way into a refused job card.
       *
       * It goes to the job's own tabs — the completion write-up, the captured
       * work, the checklist, the photos — because correcting a job card is
       * editing the job, not operating a separate editor. The refusal panel at
       * the top of that screen is where it is then sent back for signature or
       * closed without one.
       */
      if (office) {
        actions.push(
          <Button
            key="correct"
            size="lg"
            onClick={onCompleteJob}
            leadingIcon={<Icon name="wrench" className="size-5" />}
          >
            Correct &amp; resubmit
          </Button>,
          <Button
            key="review"
            size="lg"
            variant="secondary"
            onClick={() => router.push(`/jobs/${job.jobNumber}/review`)}
            leadingIcon={<Icon name="warning" className="size-5" />}
          >
            Signature refusal — awaiting resolution
          </Button>,
        );
      }
    } else {
      /*
       * A SIGNED JOB CARD, WAITING FOR ITS OWN TECHNICIAN TO SUBMIT IT.
       * MASTER SCOPE CR-07.
       *
       * THE SUBMISSION HAPPENS HERE, not on the review screen. The normal
       * signed journey used to read "Review & submit job card" → office review
       * page → a MASTER submits, and there is no office step in it any more:
       * the person who did the work and took the signature submits it, and
       * they do it from the job they are standing on.
       *
       * The office is offered nothing on an ordinary signed job card, because
       * there is nothing for them to do with it. `canSubmitJobCard` is the
       * same rule the server applies, so the button and the operation cannot
       * disagree — including on its two exceptions, a parts collection and a
       * job stranded in the retired Master Review stage.
       */
      const readiness = checkReadyForSubmission(job);
      const blocked = submissionBlocker(view);

      if (canSubmitJobCard(currentUser, job) && readiness.allowed && blocked === null) {
        actions.push(
          <Button
            key="submit"
            size="lg"
            onClick={() => setSubmitting(true)}
            leadingIcon={<Icon name="mail" className="size-5" />}
          >
            {job.jobType === 'parts' ? 'Submit collection note' : 'Submit job card'}
          </Button>,
        );
      }

      // The document itself, for whoever is looking — including the office,
      // who may read a signed job card without having anything to do to it.
      actions.push(
        <Button
          key="review"
          size="lg"
          variant="secondary"
          onClick={() => router.push(`/jobs/${job.jobNumber}/review`)}
          leadingIcon={<Icon name="document" className="size-5" />}
        >
          View job card
        </Button>,
      );
    }
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

  /*
   * THE RETIRED MASTER REVIEW STAGE, and the ONE place that phrase still
   * legitimately appears. Nothing can enter `submitted` any more; the jobs
   * sitting in it entered before it was retired and still have to be able to
   * leave, which under CR-07 only a Master can do for them — there is nobody
   * else, and stranding them is not an option.
   */
  if (job.status === 'submitted') {
    const master = canSubmitJobCard(currentUser, job);
    actions.push(
      <Button
        key="master-review"
        size="lg"
        variant={master ? 'primary' : 'secondary'}
        disabled={!master}
        onClick={() => router.push(`/jobs/${job.jobNumber}/review`)}
        leadingIcon={<Icon name="document" className="size-5" />}
      >
        {master ? 'Issue this historical job card' : 'Held in the retired review stage'}
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

      {/* The final submission, in the one component every screen that offers
          it uses. CR-07: the technician submits from the job, not from an
          office review page. */}
      <SubmitJobCardDialog
        view={view}
        open={submitting}
        onClose={() => setSubmitting(false)}
        onSubmitted={onChanged}
      />

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
          const ok = await operation.run(() => jobs.returnToProgress(job.id));
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
                const ok = await operation.run(() =>
                  jobs.awaitingSpares(job.id, sparesReason.trim()),
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
