'use client';

import { useState } from 'react';
import { can, deliveryStateLabel, type Job, type UnsignedDeliveryAuthorisation, type User } from '@/domain';
import { Badge, Button, Card, CardHeader } from '@/components/ui';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';
import { jobs as api } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';
import { useCurrentUser } from '@/providers/AppProvider';
import { formatDateTime } from '@/lib/format';
import { userFullName } from '@/domain';

/**
 * SENDING A JOB CARD THE CUSTOMER DID NOT SIGN. BD-06, DELIV-7, AUD-4.
 *
 * WHAT THIS PANEL SAYS FIRST, and it is the whole point: nothing has been
 * sent. A job card issued without a signature produces a document and delivers
 * nothing, deliberately — a customer who declined to sign must not be e-mailed
 * a copy because a workflow finished.
 *
 * SO THE PANEL IS AN ANSWER TO "and now?" rather than a button. It states the
 * position, offers a MASTER the explicit authorisation with a reason, and then
 * reports what the provider actually said. "Queued" is not "sent" and "sent"
 * is not "delivered", which is the rule the rest of this application already
 * follows.
 */
export const UnsignedDeliveryPanel = ({
  job,
  authorisation,
  users,
  onChanged,
}: {
  readonly job: Job;
  readonly authorisation: UnsignedDeliveryAuthorisation | null;
  readonly users: readonly User[];
  readonly onChanged: () => void;
}) => {
  const currentUser = useCurrentUser();
  const operation = useOperation();
  const mayAuthorise = can(currentUser.role, 'jobs.authoriseUnsignedDelivery');
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');

  const authorisedBy =
    authorisation === null
      ? null
      : (users.find((user) => user.id === authorisation.authorisedBy) ?? null);

  const authorise = async (): Promise<void> => {
    const ok = await operation.run(() => api.authoriseUnsignedDelivery(job.id, reason));
    if (!ok) return;
    setReason('');
    setOpen(false);
    onChanged();
  };

  const retry = async (): Promise<void> => {
    const ok = await operation.run(() => api.retryUnsignedDelivery(job.id));
    if (ok) onChanged();
  };

  const delivery = job.delivery;
  const attempted = delivery !== null && delivery.attempts > 0;

  return (
    // The test id goes on a wrapper: `Card` does not forward one.
    <Card className="mb-5">
      <div data-testid="unsigned-delivery">
      <CardHeader
        title="The customer's copy"
        description="This job card was issued without a customer signature."
        action={
          authorisation === null ? (
            <Badge tone="neutral" dot>
              Not sent
            </Badge>
          ) : (
            <Badge tone={delivery?.state === 'failed' ? 'amber' : 'green'} dot>
              {attempted ? deliveryStateLabel(delivery.state) : 'Authorised'}
            </Badge>
          )
        }
      />

      {authorisation === null ? (
        <>
          <p className="mt-4 text-sm leading-relaxed text-steel-700" data-testid="unsigned-not-sent">
            <strong>Nothing has been sent to the customer.</strong> The job card was issued without a
            signature, so no copy was e-mailed — that is deliberate, and it stays that way unless a
            Master decides otherwise. The document itself is on file and records the refusal and its
            reason.
          </p>

          {mayAuthorise &&
            (open ? (
              <div className="mt-3 space-y-3">
                <div>
                  <label
                    className="text-xs font-semibold tracking-wide text-steel-500 uppercase"
                    htmlFor="unsigned-reason"
                  >
                    Why this is being sent
                  </label>
                  <textarea
                    id="unsigned-reason"
                    value={reason}
                    maxLength={2000}
                    rows={2}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="The customer asked for a copy for their insurer."
                    className="mt-1 w-full rounded-[var(--radius-control)] border border-steel-300 bg-surface px-3 py-2 text-sm placeholder:text-steel-400 focus:border-eje-500 focus:ring-2 focus:ring-eje-100 focus:outline-none"
                    data-testid="unsigned-reason"
                  />
                  <p className="mt-1 text-xs leading-relaxed text-steel-400">
                    Recorded with your name and the time on the audit trail, against this exact
                    document. It goes to the contact person on the job and nowhere else.
                  </p>
                </div>

                {operation.error !== null && (
                  <RuleViolationNotice
                    title="Nothing was sent"
                    message={operation.error}
                    violations={operation.violations}
                  />
                )}

                <div className="flex gap-2">
                  <Button
                    type="button"
                    loading={operation.running}
                    onClick={() => void authorise()}
                    data-testid="unsigned-authorise-save"
                  >
                    Authorise and send
                  </Button>
                  <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                type="button"
                variant="secondary"
                className="mt-3"
                onClick={() => setOpen(true)}
                data-testid="unsigned-authorise"
              >
                Authorise sending it to the customer
              </Button>
            ))}

          {!mayAuthorise && (
            <p className="mt-3 text-xs text-steel-500">
              Sending it anyway is a Master’s decision.
            </p>
          )}
        </>
      ) : (
        <>
          <dl className="mt-4 space-y-2 text-sm" data-testid="unsigned-authorisation">
            <div className="flex justify-between gap-3">
              <dt className="text-steel-500">Authorised by</dt>
              <dd className="text-right font-medium text-steel-800">
                {authorisedBy === null ? 'Somebody no longer on the system' : userFullName(authorisedBy)}
                {' · '}
                {formatDateTime(authorisation.authorisedAt)}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-steel-500">Sent to</dt>
              <dd className="text-right font-medium text-steel-800">{authorisation.recipient}</dd>
            </div>
            <div>
              <dt className="text-steel-500">Reason</dt>
              <dd className="mt-0.5 text-steel-800">{authorisation.reason}</dd>
            </div>
          </dl>

          {attempted && (
            <p className="mt-3 text-xs text-steel-600" data-testid="unsigned-delivery-state">
              Attempt {delivery.attempts}: {deliveryStateLabel(delivery.state)}
              {delivery.failureReason.length > 0 ? ` — ${delivery.failureReason}` : ''}
            </p>
          )}

          {operation.error !== null && (
            <div className="mt-3">
              <RuleViolationNotice
                title="That attempt did not go through"
                message={operation.error}
                violations={operation.violations}
              />
            </div>
          )}

          {/*
            RETRYABLE, AND WITHOUT A SECOND AUTHORISATION. The decision was
            taken; a provider failure does not undo it.
          */}
          {mayAuthorise && delivery?.state === 'failed' && (
            <Button
              type="button"
              variant="secondary"
              className="mt-3"
              loading={operation.running}
              onClick={() => void retry()}
              data-testid="unsigned-retry"
            >
              Send again
            </Button>
          )}
        </>
      )}
      </div>
    </Card>
  );
};
