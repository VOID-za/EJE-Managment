'use client';

import { useState } from 'react';
import {
  can,
  outstandingRefusal,
  refusalResolutionLabel,
  signatoryLabelsFor,
  userFullName,
  type Job,
  type SignatureRefusal,
  type User,
} from '@/domain';
import { Badge, Button, Card, ConfirmDialog, Icon, TextAreaField } from '@/components/ui';
import { jobs } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';
import { cn } from '@/lib/cn';
import { useCurrentUser } from '@/providers/AppProvider';
import { formatDateTime } from '@/lib/format';
import { RuleViolationNotice } from './RuleViolationNotice';

/**
 * The customer's refusals to sign, and what the office did about them.
 *
 * Shown wherever the job is being read, because a refused job card is the one
 * thing about the job that anyone opening it has to know first. It is an
 * exception panel, not a stage and not a status: the job is at Review like any
 * other finished job, and this says what happened at the signature.
 *
 * For the office it is also where the exception is cleared, and there are two
 * honest ways to do that:
 *
 * - CUSTOMER SIGNATURE — the normal one. Put right whatever the customer
 *   objected to and ask them again. The job goes back to Customer Signature
 *   carrying everything on it; nothing is captured twice.
 * - WITHOUT CUSTOMER SIGNATURE — for the customer who will not sign whatever is
 *   put in front of them. The job card goes out recording the refusal and the
 *   job CLOSES there and then: no second signature step, no review after it.
 *
 * Every refusal stays listed, including ones already dealt with, so a job that
 * took three attempts says so.
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
  const currentUser = useCurrentUser();
  const operation = useOperation();
  const [note, setNote] = useState('');
  const [confirmIssue, setConfirmIssue] = useState(false);

  // Nothing to show, and nothing leaked: a technician who may not read this
  // job's refusals was handed a job with none on it. See `loadJobView`.
  if (job.signatureRefusals.length === 0) return null;

  const labels = signatoryLabelsFor(job.jobType);
  const outstanding = outstandingRefusal(job);
  const nameOf = (id: string | null): string => {
    if (id === null) return 'the office';
    const user = users.find((candidate) => candidate.id === id);
    return user === undefined ? 'the office' : userFullName(user);
  };

  const canResolve = can(currentUser.role, 'jobs.resolveSignatureRefusal');
  const canResubmit = can(currentUser.role, 'jobs.resubmitForSignature');
  const attempts = job.signatureRefusals.length;

  return (
    <Card
      className={cn(
        'mb-5',
        outstanding === null ? 'border-steel-200' : 'border-amber-eje-300 bg-amber-eje-50',
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'flex size-10 shrink-0 items-center justify-center rounded-full text-white',
            outstanding === null ? 'bg-steel-400' : 'bg-amber-eje-500',
          )}
        >
          <Icon name="warning" className="size-5" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-bold tracking-wide text-steel-900 uppercase">
              {labels.refusedLabel}
            </p>
            <Badge tone={outstanding === null ? 'green' : 'amber'} size="sm" dot>
              {outstanding === null ? 'Resolved' : 'Awaiting resolution'}
            </Badge>
            {attempts > 1 && (
              <Badge tone="neutral" size="sm">
                {attempts} refusals
              </Badge>
            )}
          </div>

          {/* Oldest first, so the panel reads as the story of the job: refused,
              corrected, refused again. Nothing here is ever overwritten. */}
          <ol className="mt-3 space-y-3">
            {job.signatureRefusals.map((refusal, index) => (
              <RefusalEntry
                key={`${refusal.recordedAt}-${index}`}
                refusal={refusal}
                index={index}
                total={attempts}
                nameOf={nameOf}
              />
            ))}
          </ol>

          {outstanding !== null && (
            <div className="mt-4 space-y-2 text-sm text-steel-700">
              <p>
                The work and the write-up stand as recorded, and this job card is now the
                office&rsquo;s. There are two ways it can end:
              </p>
              {/* Named and explained, because the two outcomes are not
                  symmetrical: one asks the customer again, the other finishes
                  the job for good. */}
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  <span className="font-semibold text-steel-900">Customer Signature</span> —
                  correct whatever the customer objected to, then send the job card back to the
                  signature step. The technician captures nothing again; only the signature is
                  asked for.
                </li>
                <li>
                  <span className="font-semibold text-steel-900">Without Customer Signature</span>{' '}
                  — the customer will not sign whatever is put in front of them. The job card is
                  produced recording the refusal and{' '}
                  <span className="font-semibold text-steel-900">the job closes immediately</span>.
                  There is no further signature step and nothing can be changed afterwards.
                </li>
              </ul>
            </div>
          )}

          {outstanding !== null && (canResubmit || canResolve) && (
            <div className="mt-4">
              <TextAreaField
                label="What was decided"
                rows={3}
                hint="Optional. Recorded on the job with your decision."
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />

              <div className="mt-3 flex flex-wrap gap-2">
                {canResubmit && (
                  <Button
                    loading={operation.running}
                    leadingIcon={<Icon name="signature" className="size-5" />}
                    onClick={async () => {
                      const ok = await operation.run(() =>
                        jobs.returnForSignature(job.id, note),
                      );
                      if (ok) onChanged();
                    }}
                  >
                    Customer Signature
                  </Button>
                )}
                {canResolve && (
                  <Button
                    variant="secondary"
                    disabled={operation.running}
                    leadingIcon={<Icon name="document" className="size-5" />}
                    onClick={() => setConfirmIssue(true)}
                  >
                    Without Customer Signature
                  </Button>
                )}
              </div>
            </div>
          )}

          {operation.error !== null && (
            <div className="mt-4">
              <RuleViolationNotice
                title="The signature refusal could not be resolved"
                message={operation.error}
                violations={operation.violations}
              />
            </div>
          )}
        </div>
      </div>

      {/*
        Confirmed, because it is the end of the conversation with the customer.
        The job card goes out saying they would not sign it, and that document
        is then frozen.
      */}
      <ConfirmDialog
        open={confirmIssue}
        title="Close without a customer signature?"
        message={`${job.jobNumber} will be issued as it stands and CLOSED. The job card records that the customer refused to sign rather than carrying a signature, there is no further signature step, and nothing on the job can be changed afterwards. Choose Customer Signature instead if anything on it can still be put right.`}
        confirmLabel="Close without a signature"
        onCancel={() => setConfirmIssue(false)}
        onConfirm={async () => {
          const ok = await operation.run(() => jobs.resolveRefusal(job.id, note));
          setConfirmIssue(false);
          if (ok) onChanged();
        }}
      />
    </Card>
  );
};

/** One refusal, and what became of it. */
const RefusalEntry = ({
  refusal,
  index,
  total,
  nameOf,
}: {
  readonly refusal: SignatureRefusal;
  readonly index: number;
  readonly total: number;
  readonly nameOf: (id: string | null) => string;
}) => (
  <li className="rounded-[var(--radius-control)] border border-steel-200 bg-surface p-3">
    {total > 1 && (
      <p className="text-xs font-semibold tracking-wide text-steel-500 uppercase">
        Refusal {index + 1}
      </p>
    )}
    <p className="mt-1 text-xs font-semibold tracking-wide text-steel-500 uppercase">Reason</p>
    <p className="mt-0.5 text-sm leading-relaxed whitespace-pre-wrap text-steel-800">
      {refusal.reason}
    </p>

    <dl className="mt-2 space-y-0.5 text-xs text-steel-600">
      <Row label="Recorded by" value={nameOf(refusal.recordedBy)} />
      <Row label="Recorded" value={formatDateTime(refusal.recordedAt)} />
      {refusal.resolvedAt !== null && refusal.resolution !== null && (
        <>
          <Row label="Outcome" value={refusalResolutionLabel(refusal.resolution)} />
          <Row label="Resolved by" value={nameOf(refusal.resolvedBy)} />
          <Row label="Resolved" value={formatDateTime(refusal.resolvedAt)} />
          {refusal.resolutionNote.length > 0 && (
            <Row label="Decision" value={refusal.resolutionNote} />
          )}
        </>
      )}
    </dl>
  </li>
);

const Row = ({ label, value }: { readonly label: string; readonly value: string }) => (
  <div className="flex gap-2">
    <dt className="w-24 shrink-0 text-steel-500">{label}</dt>
    <dd className="whitespace-pre-wrap text-steel-800">{value}</dd>
  </div>
);
