'use client';

import { useState } from 'react';
import {
  can,
  changeRequestStateLabel,
  contactFullName,
  userFullName,
  type ChangeRequest,
  type Contact,
  type Job,
  type User,
} from '@/domain';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Icon,
  Modal,
  SelectField,
  TextAreaField,
} from '@/components/ui';
import { changeRequests } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';
import { useCurrentUser } from '@/providers/AppProvider';
import { formatDateTime } from '@/lib/format';
import { RuleViolationNotice } from './RuleViolationNotice';

/**
 * WHAT THE CUSTOMER HAS ASKED FOR ON THIS JOB. CUST-CR, the job half.
 *
 * WHO RAISES ONE. The customer — and a customer has no account in this system,
 * so the request arrives by telephone or is said to the technician standing in
 * their workshop, and somebody at EJE writes it down. Anybody who may SEE the
 * job may record one, because "while you are here, can you look at the Y axis
 * too" is exactly the request most worth having written down and the technician
 * is the person it is said to.
 *
 * WHAT IT CHANGES: nothing. There is no proposed value and no apply button —
 * the request carries the customer's words, and the office records what it
 * decided. That is the same discipline as the register half, and it is why a
 * button labelled "apply" would be a lie about what happened.
 *
 * AFTER THE CUSTOMER HAS SIGNED, one of these is still worth raising — a
 * customer querying an issued job card is precisely when they ask — and BD-02
 * already answered what happens next: the document stays immutable and a Master
 * raises a CORRECTION with its own addendum. The panel says so, so nobody
 * expects the job card to change.
 */
export const CustomerJobRequestsPanel = ({
  job,
  requests,
  contacts,
  users,
  onChanged,
}: {
  readonly job: Job;
  readonly requests: readonly ChangeRequest[];
  readonly contacts: readonly Contact[];
  readonly users: readonly User[];
  readonly onChanged: () => void;
}) => {
  const currentUser = useCurrentUser();
  const operation = useOperation();
  const [raising, setRaising] = useState(false);
  const [resolving, setResolving] = useState<ChangeRequest | null>(null);
  const [details, setDetails] = useState('');
  const [contactId, setContactId] = useState('');
  const [note, setNote] = useState('');
  const [outcome, setOutcome] = useState<'applied' | 'declined'>('applied');
  const [error, setError] = useState<string | null>(null);

  // The office decides what to do about one. The server checks it too.
  const mayResolve = can(currentUser.role, 'jobs.viewAll');
  const signed = job.signature !== null;

  const nameOf = (id: string): string => {
    const user = users.find((candidate) => candidate.id === id);
    return user === undefined ? 'Somebody at EJE' : userFullName(user);
  };

  const askedBy = (request: ChangeRequest): string => {
    if (request.requestedByContactId === null) return 'The customer';
    const contact = contacts.find((candidate) => candidate.id === request.requestedByContactId);
    return contact === undefined ? 'The customer' : contactFullName(contact);
  };

  const open = requests.filter((request) => request.state === 'open');

  return (
    <Card padded={false} className="mb-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-steel-100 px-5 py-4">
        <CardHeader
          title="What the customer has asked for"
          description={
            requests.length === 0
              ? 'Nothing recorded on this job'
              : `${requests.length} recorded${open.length > 0 ? ` · ${open.length} waiting for the office` : ''}`
          }
        />
        <Button
          size="sm"
          variant="secondary"
          leadingIcon={<Icon name="plus" className="size-4" />}
          onClick={() => {
            setDetails('');
            setContactId('');
            setError(null);
            setRaising(true);
          }}
          data-testid="record-customer-request"
        >
          Record a request
        </Button>
      </div>

      {requests.length === 0 ? (
        <p className="px-5 py-4 text-sm text-steel-500">
          If the customer asks for something on this job — more work, a different date, a change
          to what was agreed — record it here. It is written down against the job and nothing is
          changed by itself.
        </p>
      ) : (
        <ul className="divide-y divide-steel-100">
          {requests.map((request) => (
            <li key={request.id} className="px-5 py-4" data-testid="customer-job-request">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <p className="text-sm font-medium text-steel-900">{askedBy(request)} asked:</p>
                <Badge tone={request.state === 'open' ? 'amber' : 'neutral'} size="sm">
                  {changeRequestStateLabel(request.state)}
                </Badge>
              </div>
              <p className="mt-1 text-sm text-steel-700">{request.details}</p>
              <p className="mt-1 text-xs text-steel-500">
                Recorded by {nameOf(request.raisedBy)} · {formatDateTime(request.raisedAt)}
              </p>
              {request.state !== 'open' && (
                <p className="mt-2 rounded-[var(--radius-control)] bg-steel-50 px-3 py-2 text-sm text-steel-700">
                  <span className="font-medium">
                    {request.resolvedBy === null ? 'The office' : nameOf(request.resolvedBy)}:
                  </span>{' '}
                  {request.resolutionNote}
                </p>
              )}
              {request.state === 'open' && mayResolve && (
                <Button
                  size="sm"
                  variant="secondary"
                  className="mt-2"
                  onClick={() => {
                    setNote('');
                    setOutcome('applied');
                    setError(null);
                    setResolving(request);
                  }}
                >
                  Record what you did
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={raising}
        title="Record what the customer asked for"
        description="Their words, against this job. Nothing on the job is changed by recording it."
        onClose={() => setRaising(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRaising(false)} disabled={operation.running}>
              Cancel
            </Button>
            <Button
              loading={operation.running}
              onClick={async () => {
                if (details.trim().length === 0) {
                  setError('Say what the customer asked for.');
                  return;
                }
                setError(null);
                const ok = await operation.run(() =>
                  changeRequests.raise({
                    subject: 'job',
                    customerId: job.customerId,
                    jobId: job.id,
                    ...(contactId.length > 0 ? { requestedByContactId: contactId } : {}),
                    details: details.trim(),
                  }),
                );
                if (ok) {
                  setRaising(false);
                  onChanged();
                }
              }}
            >
              Record it
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {operation.error !== null && (
            <RuleViolationNotice
              title="That could not be recorded"
              message={operation.error}
              violations={operation.violations}
            />
          )}
          {signed && (
            <p className="rounded-[var(--radius-control)] border border-amber-eje-200 bg-amber-eje-50 px-3.5 py-2.5 text-sm text-amber-eje-800">
              The customer has signed this job card, so it cannot be changed. Recording what they
              asked for is still worth doing — a Master issues a <strong>correction</strong> with
              its own addendum if EJE decide the document is wrong.
            </p>
          )}
          <SelectField
            label="Who asked"
            value={contactId}
            onChange={(event) => setContactId(event.target.value)}
            options={[
              { value: '', label: 'Not recorded' },
              ...contacts.map((contact) => ({
                value: contact.id,
                label: contactFullName(contact),
              })),
            ]}
            hint="Leave it as “not recorded” if you do not know which of their people telephoned."
          />
          <TextAreaField
            label="What they asked for"
            rows={4}
            value={details}
            onChange={(event) => setDetails(event.target.value)}
            error={error ?? undefined}
            placeholder="e.g. While you are on site, please also check the Y-axis bearing noise."
            required
          />
        </div>
      </Modal>

      <Modal
        open={resolving !== null}
        title="What did you do about it?"
        description="Your words. The system changes nothing on the job either way."
        onClose={() => setResolving(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setResolving(null)} disabled={operation.running}>
              Cancel
            </Button>
            <Button
              loading={operation.running}
              onClick={async () => {
                if (resolving === null) return;
                if (note.trim().length === 0) {
                  setError('Say what you did. A decision with no words leaves nobody able to tell.');
                  return;
                }
                setError(null);
                const ok = await operation.run(() =>
                  changeRequests.resolve(resolving.id, { outcome, note: note.trim() }),
                );
                if (ok) {
                  setResolving(null);
                  onChanged();
                }
              }}
            >
              Record the decision
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {operation.error !== null && (
            <RuleViolationNotice
              title="That could not be recorded"
              message={operation.error}
              violations={operation.violations}
            />
          )}
          <SelectField
            label="Outcome"
            value={outcome}
            onChange={(event) => setOutcome(event.target.value as 'applied' | 'declined')}
            options={[
              { value: 'applied', label: 'We did it' },
              { value: 'declined', label: 'We are not doing it' },
            ]}
            hint="“We did it” records that a PERSON made the change. Nothing here edits the job."
          />
          <TextAreaField
            label="What you did, and why"
            rows={4}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            error={error ?? undefined}
            placeholder={
              signed
                ? 'e.g. Raised correction 2 against the issued job card; the customer has the addendum.'
                : 'e.g. Added the Y-axis check to the job and told the technician.'
            }
            required
          />
        </div>
      </Modal>
    </Card>
  );
};
