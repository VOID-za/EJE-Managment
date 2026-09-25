'use client';

import { useState } from 'react';
import {
  availabilityTypeLabel,
  contactFullName,
  userFullName,
  type SubmissionCover,
  type User,
} from '@/domain';
import type { JobView } from '@/application/job-view';
import { ConfirmDialog } from '@/components/ui';
import { jobs as api } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';
import { RuleViolationNotice } from './RuleViolationNotice';

/**
 * The office submits a signed job card its technician cannot. MASTER SCOPE CR-08.
 *
 * Deliberately its own component, its own wording and its own confirmation,
 * separate from `SubmitJobCardDialog`. The two are not the same act and must
 * never read as though they were: one is the last step of somebody's own job,
 * the other is an exception the office is taking on their behalf, and the
 * person doing it should be told exactly that before they do it.
 *
 * What it says out loud, because it is the thing most worth being sure of: the
 * signed job card is FINAL. A takeover cannot change a figure, a word of the
 * write-up or the signature, and cannot produce a different document. It sends
 * the one the technician would have sent.
 */
export const TakeOverSubmissionDialog = ({
  view,
  cover,
  users,
  open,
  onClose,
  onSubmitted,
}: {
  readonly view: JobView;
  readonly cover: SubmissionCover;
  readonly users: readonly User[];
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSubmitted: () => void;
}) => {
  const { job, customer, contact } = view;
  const operation = useOperation();
  const [failed, setFailed] = useState(false);

  const email = contact?.email.trim() ?? '';
  const recipient = contact === null ? customer.name : contactFullName(contact);
  const nameOf = (id: string): string => {
    const person = users.find((candidate) => candidate.id === id);
    return person === undefined ? 'the technician' : userFullName(person);
  };

  return (
    <>
      {failed && operation.error !== null && (
        <div className="mb-5">
          <RuleViolationNotice
            title="This submission could not be taken over"
            message={operation.error}
            violations={operation.violations}
          />
        </div>
      )}

      <ConfirmDialog
        open={open}
        title="Take over this submission?"
        message={
          <>
            {/* The grounds, named. A takeover is an exception, and an exception
                nobody can see the reason for is indistinguishable from a
                permission somebody quietly acquired. */}
            <p>
              {cover.unassigned
                ? `${job.jobNumber} names nobody who can submit it.`
                : cover.blocked
                    .map((block) =>
                      block.kind === 'account_disabled'
                        ? `${nameOf(block.userId)}'s account is disabled.`
                        : `${nameOf(block.userId)} is on ${availabilityTypeLabel(
                            block.absence,
                          ).toLowerCase()} from ${block.from} to ${block.to}.`,
                    )
                    .join(' ')}{' '}
              The customer has signed {job.jobNumber}, so it is finished work waiting to be sent.
            </p>

            <p className="mt-3 rounded-[var(--radius-control)] bg-steel-50 px-3 py-2.5 text-sm text-steel-700">
              <span className="font-semibold text-steel-900">Nothing can be changed.</span> The
              signed job card is final: the write-up, the labour, the travel, the parts, the
              pricing and the signature are all fixed, and this sends the customer exactly the
              document {nameOf(job.primaryTechnicianId ?? '')} would have sent.
            </p>

            <p className="mt-3">
              It will be emailed to {recipient}
              {email.length === 0 ? '' : ` at ${email}`}, and {job.jobNumber} closes once delivery
              is confirmed. Your name is recorded against the takeover on the job&rsquo;s activity
              trail.
            </p>
          </>
        }
        confirmLabel="Take over submission"
        cancelLabel="Cancel"
        busy={operation.running}
        onConfirm={async () => {
          setFailed(false);
          const ok = await operation.run(async () => {
            await api.takeOverSubmission(job.id);
            onSubmitted();
          });
          if (!ok) setFailed(true);
          else onClose();
        }}
        onCancel={onClose}
      />
    </>
  );
};
