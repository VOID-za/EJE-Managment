'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { canAcceptJob, checkReadyForSignature } from '@/domain';
import {
  acceptJob,
  buildSiteLocationMessage,
  declineSiteLocation,
  sendSiteLocation,
  moveToAwaitingSpares,
  returnToInProgress,
  startCompletion,
  startSignature,
  type SiteLocationInput,
} from '@/application/job-operations';
import type { JobView } from '@/application/job-view';
import type { Job } from '@/domain';
import { Badge, Button, ConfirmDialog, Icon, Modal, TextAreaField } from '@/components/ui';
import { useOperation } from '@/hooks/useOperation';
import { useApp } from '@/providers/AppProvider';
import { RuleViolationNotice } from './RuleViolationNotice';

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
  const { operationContext } = useApp();
  const [confirmAccept, setConfirmAccept] = useState(false);
  const [sparesOpen, setSparesOpen] = useState(false);
  const [sparesReason, setSparesReason] = useState('');
  const [confirmResume, setConfirmResume] = useState(false);

  // Shown only after acceptance has already succeeded, so answering it — either
  // way — cannot affect whether the job is accepted.
  const [locationPrompt, setLocationPrompt] = useState<Job | null>(null);
  const [locationBusy, setLocationBusy] = useState(false);
  const [locationOutcome, setLocationOutcome] = useState<string | null>(null);

  const siteLocationInput: SiteLocationInput = {
    site: view.site,
    machine: view.machine,
    customerName: view.customer.name,
  };

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

  if (
    actions.length === 0 &&
    operation.error === null &&
    locationOutcome === null &&
    locationPrompt === null
  ) {
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

      {locationOutcome !== null && (
        <div className="flex items-start gap-2 rounded-[var(--radius-control)] border border-steel-200 bg-steel-50 px-3 py-2.5 text-sm text-steel-700">
          <Icon name="whatsapp" className="mt-0.5 size-4 shrink-0 text-verdant-600" />
          <span className="flex-1">{locationOutcome}</span>
          <button
            type="button"
            onClick={() => setLocationOutcome(null)}
            aria-label="Dismiss"
            className="text-steel-400 hover:text-steel-700"
          >
            <Icon name="close" className="size-4" />
          </button>
        </div>
      )}

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
          let accepted: Job | null = null;
          const ok = await operation.run(async (context) => {
            accepted = await acceptJob(context, job);
          });
          setConfirmAccept(false);
          if (!ok) return;

          onChanged();
          // Offer the site location only once the job is safely accepted.
          setLocationOutcome(null);
          setLocationPrompt(accepted);
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
        open={locationPrompt !== null}
        title="Send Site Location?"
        onClose={() => setLocationPrompt(null)}
        size="sm"
        footer={
          <>
            <Button
              variant="secondary"
              disabled={locationBusy}
              onClick={async () => {
                const accepted = locationPrompt;
                setLocationPrompt(null);
                if (accepted === null) return;
                // Recorded, but nothing is sent.
                setLocationBusy(true);
                try {
                  await declineSiteLocation(operationContext(), accepted);
                } catch {
                  // Recording the choice is best-effort and must never surface
                  // as a failure on an accepted job.
                } finally {
                  setLocationBusy(false);
                  onChanged();
                }
              }}
            >
              No, Thanks
            </Button>
            <Button
              loading={locationBusy}
              leadingIcon={<Icon name="whatsapp" className="size-4" />}
              onClick={async () => {
                const accepted = locationPrompt;
                if (accepted === null) return;
                setLocationBusy(true);
                // sendSiteLocation never throws: a WhatsApp failure is reported
                // here and recorded on the trail, and the job stays accepted.
                const result = await sendSiteLocation(
                  operationContext(),
                  accepted,
                  siteLocationInput,
                );
                setLocationBusy(false);
                setLocationPrompt(null);
                setLocationOutcome(
                  result.sent
                    ? `Site location queued to ${view.primaryTechnician?.mobile ?? 'the technician'}.`
                    : `The site location could not be sent: ${result.failureReason ?? 'unknown error'}. ${job.jobNumber} is still accepted and in progress.`,
                );
                onChanged();
              }}
            >
              Send Location
            </Button>
          </>
        }
      >
        <div className="space-y-4 text-sm text-steel-700">
          <p>Would you like to send the site location to the technician via WhatsApp?</p>

          <div className="rounded-[var(--radius-control)] bg-steel-50 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-xs font-semibold tracking-wide text-steel-500 uppercase">
                Message preview
              </span>
              <Badge tone="amber" size="sm">
                Simulated
              </Badge>
            </div>
            <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap text-steel-700">
              {buildSiteLocationMessage(siteLocationInput, job.jobNumber)}
            </pre>
          </div>

          <p className="text-xs text-steel-500">
            The link opens turn-by-turn navigation to the saved site location. This is optional —
            {' '}
            {job.jobNumber} is already accepted and in progress either way.
          </p>
        </div>
      </Modal>

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
