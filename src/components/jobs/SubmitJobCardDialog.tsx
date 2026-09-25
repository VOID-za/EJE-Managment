'use client';

import { useState } from 'react';
import { contactFullName, type DeliveryRecord } from '@/domain';
import type { JobView } from '@/application/job-view';
import { ConfirmDialog } from '@/components/ui';
import { jobs as api } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';
import { RuleViolationNotice } from './RuleViolationNotice';

export interface SubmittedJobCard {
  readonly fileName: string;
  readonly to: string;
  readonly delivery: DeliveryRecord;
}

/**
 * The final submission, as one component used everywhere it is offered.
 *
 * THE NORMAL JOURNEY NO LONGER GOES THROUGH THE REVIEW SCREEN. MASTER SCOPE
 * CR-07. The technician signs, looks at the signed document and submits it —
 * from the close-out wizard they are already standing in, or from the job
 * itself if they left it. Neither should have to navigate to an office review
 * page that exists for a different workflow, and neither should carry its own
 * copy of this confirmation.
 *
 * It is one call: `POST /api/jobs/:id/issue`. Everything the submission does —
 * freeze the price, render and store the customer's copy, email it, start the
 * delivery handshake — is the server's, and the authorisation is the server's
 * too. Nothing here decides anything.
 */
export const SubmitJobCardDialog = ({
  view,
  open,
  onClose,
  onSubmitted,
}: {
  readonly view: JobView;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSubmitted: (result: SubmittedJobCard) => void;
}) => {
  const { job, customer, contact } = view;
  const operation = useOperation();
  const [failed, setFailed] = useState(false);

  /*
   * The recipient the job card actually goes to.
   *
   * Read for the WORDING only — the server resolves the address itself from
   * the job's contact and never accepts one from the browser (DECISION 4), so
   * this cannot redirect a customer's signed job card anywhere.
   */
  const email = contact?.email.trim() ?? '';
  const recipient = contact === null ? customer.name : contactFullName(contact);
  const parts = job.jobType === 'parts';

  return (
    <>
      {failed && operation.error !== null && (
        <div className="mb-5">
          <RuleViolationNotice
            title="This job card could not be submitted"
            message={operation.error}
            violations={operation.violations}
          />
        </div>
      )}

      <ConfirmDialog
        open={open}
        title={parts ? 'Submit collection note?' : 'Submit job card?'}
        message={
          <>
            <p>
              The {parts ? 'signed collection note' : 'signed job card'} will be generated and
              emailed to {recipient}
              {email.length === 0 ? '' : ` at ${email}`}. This cannot be undone: once submitted,
              nothing on the job can be changed.
            </p>
            <p className="mt-2 text-steel-500">
              {job.jobNumber} closes when the customer&rsquo;s copy is confirmed delivered — not
              when it is sent. If delivery is still pending or fails, the job stays open and can be
              re-sent.
            </p>
            <p className="mt-3 rounded-[var(--radius-control)] bg-amber-eje-50 px-3 py-2.5 text-xs text-amber-eje-700">
              Demonstration mode: no mail leaves the browser. The message is recorded in the
              Simulated Outbox, where delivery is confirmed or failed by hand — which is what the
              provider&rsquo;s delivery report does in production.
            </p>
          </>
        }
        confirmLabel={parts ? 'Submit collection note' : 'Submit job card'}
        cancelLabel="Cancel"
        busy={operation.running}
        onConfirm={async () => {
          setFailed(false);
          const ok = await operation.run(async () => {
            const result = await api.issue(job.id);
            // Reported from what the PROVIDER said, never from the call having
            // returned. The caller renders the outcome.
            onSubmitted({
              fileName: result.documentFileName,
              to: result.emailedTo,
              delivery: result.delivery,
            });
          });
          if (!ok) setFailed(true);
          else onClose();
        }}
        onCancel={onClose}
      />
    </>
  );
};

/**
 * Why this job card cannot be submitted yet, in a sentence, or null.
 *
 * Only the reasons a SCREEN can see. The operation applies the full rule —
 * `checkReadyForSubmission` and the permission — and refuses regardless; this
 * exists so the button is not offered into an obvious dead end.
 */
export const submissionBlocker = (view: JobView): string | null => {
  const email = view.contact?.email.trim() ?? '';
  if (email.length === 0) {
    const who = view.contact === null ? view.customer.name : contactFullName(view.contact);
    return `No email address is recorded for ${who}. Capture one on the customer’s contact before submitting this job card.`;
  }
  return null;
};
