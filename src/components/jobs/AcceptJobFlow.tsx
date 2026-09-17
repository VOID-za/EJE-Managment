'use client';

import { useState } from 'react';
import { getJobTypeDefinition, type Job } from '@/domain';
import {
  acceptJob,
  buildSiteLocationMessage,
  declineSiteLocation,
  sendSiteLocation,
  type SiteLocationInput,
} from '@/application/job-operations';
import { loadJobView, type JobView } from '@/application/job-view';
import { Badge, Button, ConfirmDialog, Icon, Modal } from '@/components/ui';
import { RuleViolationNotice } from './RuleViolationNotice';
import { useOperation } from '@/hooks/useOperation';
import { useQuery } from '@/hooks/useQuery';
import { useApp } from '@/providers/AppProvider';

/**
 * Accepting a job, and the site-location offer that follows it.
 *
 * One component for both, and the ONLY place either happens, because the order
 * is the whole point: acceptance completes and commits first, and only then is
 * the technician offered the location. Nothing about WhatsApp can reach back
 * and undo an accepted job.
 *
 * Every acceptance action in the system routes through here — the job screen
 * and the Open Jobs list — so the prompt appears exactly once per acceptance
 * and behaves identically wherever it was started from.
 */
export const AcceptJobFlow = ({
  jobNumber,
  view: providedView,
  open,
  onClose,
  onAccepted,
}: {
  readonly jobNumber: string;
  /** Passed when the caller already has the view, to avoid a second load. */
  readonly view?: JobView | null;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onAccepted: () => void;
}) => {
  const { operationContext } = useApp();
  const operation = useOperation();
  const [locationPrompt, setLocationPrompt] = useState<Job | null>(null);
  const [locationBusy, setLocationBusy] = useState(false);
  const [locationOutcome, setLocationOutcome] = useState<string | null>(null);

  // The caller may already hold the view (the job screen does); the Open Jobs
  // list does not, so it is loaded here rather than by every row.
  const loaded = useQuery(`accept:${jobNumber}`, (repos) =>
    providedView === undefined || providedView === null
      ? loadJobView(repos, jobNumber)
      : Promise.resolve(providedView),
  );
  const view = providedView ?? loaded.data ?? null;

  if (view === null) return null;
  const { job } = view;

  const siteLocationInput: SiteLocationInput = {
    site: view.site,
    machine: view.machine,
    customerName: view.customer.name,
  };

  const dismissOutcome = (): void => {
    setLocationOutcome(null);
    onClose();
  };

  return (
    <>
      {operation.error !== null && (
        <RuleViolationNotice
          title="The job was not accepted"
          message={operation.error}
          violations={operation.violations}
        />
      )}

      {locationOutcome !== null && (
        <div className="flex items-start gap-2 rounded-[var(--radius-control)] border border-steel-200 bg-steel-50 px-3 py-2.5 text-sm text-steel-700">
          <Icon name="whatsapp" className="mt-0.5 size-4 shrink-0 text-verdant-600" />
          <span className="flex-1">{locationOutcome}</span>
          <button
            type="button"
            onClick={dismissOutcome}
            aria-label="Dismiss"
            className="text-steel-400 hover:text-steel-700"
          >
            <Icon name="close" className="size-4" />
          </button>
        </div>
      )}

      <ConfirmDialog
        open={open && locationPrompt === null}
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
          if (!ok) {
            onClose();
            return;
          }

          onAccepted();
          // Offered only once the job is safely accepted, and only where there
          // is a site to travel to: parts are collected from the EJE counter,
          // so a site pin would send the technician nowhere.
          if (getJobTypeDefinition(job.jobType).visitsSite) {
            setLocationOutcome(null);
            setLocationPrompt(accepted);
          } else {
            onClose();
          }
        }}
        onCancel={onClose}
      />

      <Modal
        open={locationPrompt !== null}
        title="Send Site Location?"
        onClose={() => {
          setLocationPrompt(null);
          onClose();
        }}
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
                // The choice is recorded, but nothing is sent and nothing is
                // queued for later.
                setLocationBusy(true);
                try {
                  await declineSiteLocation(operationContext(), accepted);
                } catch {
                  // Best-effort: recording a declined offer must never surface
                  // as a failure on a job that is already accepted.
                } finally {
                  setLocationBusy(false);
                  onAccepted();
                  onClose();
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
                onAccepted();
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
            {job.jobNumber} is already accepted and in progress. Sending the location is optional,
            and a WhatsApp failure will not change that.
          </p>
        </div>
      </Modal>
    </>
  );
};
