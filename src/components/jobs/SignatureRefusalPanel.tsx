'use client';

import { useState } from 'react';
import { can, signatoryLabelsFor, userFullName, type Job, type User } from '@/domain';
import { acknowledgeSignatureRefusal } from '@/application/job-operations';
import { Badge, Button, Card, Icon, TextAreaField } from '@/components/ui';
import { useOperation } from '@/hooks/useOperation';
import { cn } from '@/lib/cn';
import { useCurrentUser } from '@/providers/AppProvider';
import { formatDateTime } from '@/lib/format';
import { RuleViolationNotice } from './RuleViolationNotice';

/**
 * The customer's refusal to sign, and the Master's review of it.
 *
 * Shown wherever the job is being read, because a refused job card is the one
 * thing about the job that anyone opening it has to know first. It is an
 * exception panel, not a stage: the job is at Review like any other finished
 * job, and this says what happened at the signature.
 *
 * For a Master it is also where the exception is cleared. That is deliberately
 * the minimum — read it, optionally say what you decided, record that you saw
 * it — rather than an approval workflow of its own. Acknowledging is what
 * releases the job card for issue and files the notification, so a refusal
 * cannot sit unanswered.
 */
export const SignatureRefusalPanel = ({
  job,
  users,
  onChanged,
}: {
  readonly job: Job;
  readonly users: readonly User[];
  readonly onChanged: () => void;
}) => {
  const refusal = job.signatureRefusal;
  const currentUser = useCurrentUser();
  const operation = useOperation();
  const [note, setNote] = useState('');

  if (refusal === null) return null;

  const labels = signatoryLabelsFor(job.jobType);
  const nameOf = (id: string | null): string => {
    if (id === null) return 'the office';
    const user = users.find((candidate) => candidate.id === id);
    return user === undefined ? 'the office' : userFullName(user);
  };

  const reviewed = refusal.acknowledgedAt !== null;
  const canReview = can(currentUser.role, 'jobs.reviewSignatureRefusal');

  return (
    <Card
      className={cn(
        'mb-5',
        reviewed ? 'border-steel-200' : 'border-amber-eje-300 bg-amber-eje-50',
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'flex size-10 shrink-0 items-center justify-center rounded-full text-white',
            reviewed ? 'bg-steel-400' : 'bg-amber-eje-500',
          )}
        >
          <Icon name="warning" className="size-5" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-bold tracking-wide text-steel-900 uppercase">
              {labels.refusedLabel}
            </p>
            <Badge tone={reviewed ? 'green' : 'amber'} size="sm" dot>
              {reviewed ? 'Reviewed' : 'Awaiting a Master'}
            </Badge>
          </div>

          <p className="mt-2 text-xs font-semibold tracking-wide text-steel-500 uppercase">
            Reason
          </p>
          <p className="mt-0.5 text-sm leading-relaxed whitespace-pre-wrap text-steel-800">
            {refusal.reason}
          </p>

          <p className="mt-2 text-xs text-steel-600">
            Recorded by {nameOf(refusal.recordedBy)} on {formatDateTime(refusal.recordedAt)}.
          </p>

          {reviewed && refusal.acknowledgedAt !== null && (
            <p className="mt-1 text-xs text-steel-600">
              Reviewed by {nameOf(refusal.acknowledgedBy)} on{' '}
              {formatDateTime(refusal.acknowledgedAt)}.
              {refusal.acknowledgementNote.length > 0 && ` ${refusal.acknowledgementNote}`}
            </p>
          )}

          {!reviewed && (
            <p className="mt-3 text-sm text-steel-700">
              The work and the write-up stand as recorded. The job card is not issued until a
              Master has reviewed this refusal — nothing has to be signed again.
            </p>
          )}

          {!reviewed && canReview && (
            <div className="mt-4">
              <TextAreaField
                label="What was decided"
                rows={3}
                hint="Optional. Recorded on the job with your review."
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
              <Button
                className="mt-3"
                loading={operation.running}
                leadingIcon={<Icon name="check" className="size-5" />}
                onClick={async () => {
                  const ok = await operation.run((context) =>
                    acknowledgeSignatureRefusal(context, job, note),
                  );
                  if (ok) onChanged();
                }}
              >
                Record my review
              </Button>
            </div>
          )}

          {operation.error !== null && (
            <div className="mt-4">
              <RuleViolationNotice
                title="The refusal could not be reviewed"
                message={operation.error}
                violations={operation.violations}
              />
            </div>
          )}
        </div>
      </div>
    </Card>
  );
};
