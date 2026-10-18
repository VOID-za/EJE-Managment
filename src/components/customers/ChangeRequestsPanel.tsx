'use client';

import { useState } from 'react';
import {
  changeRequestStateLabel,
  changeRequestSubjectLabel,
  userFullName,
  type ChangeRequest,
  type User,
} from '@/domain';
import { Badge, Button, Card, CardHeader, Modal, TextAreaField } from '@/components/ui';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';
import { changeRequests as api } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';
import { formatRelative } from '@/lib/format';

/**
 * WHAT SOMEBODY HAS REPORTED ABOUT THIS RECORD, AND WHAT THE OFFICE DID.
 * CUST-CR.
 *
 * The office's half of the workflow. A report says which record and what is
 * wrong with it; the office answers with one of two things and a note.
 *
 * *Applied* MEANS "I MADE THE CHANGE", NOT "THE SYSTEM MADE IT." Nothing here
 * writes to the register: the office edits the customer, the site or the
 * machine through the screens that already authorise that, and this records
 * the decision beside the report. The dialog says so, because a button
 * labelled "apply" that changes nothing would be a lie — and an automatic
 * apply is a business decision nobody has made (see
 * `change-request-operations.ts`).
 *
 * THE NOTE IS REQUIRED ON BOTH OUTCOMES. "Declined" with no reason is how
 * people stop reporting things; "applied" with no note leaves nobody able to
 * tell what was actually changed.
 */
export const ChangeRequestsPanel = ({
  requests,
  users,
  onChanged,
}: {
  readonly requests: readonly ChangeRequest[];
  readonly users: readonly User[];
  readonly onChanged: () => void;
}) => {
  const operation = useOperation();
  const [deciding, setDeciding] = useState<{
    readonly request: ChangeRequest;
    readonly outcome: 'applied' | 'declined';
  } | null>(null);
  const [note, setNote] = useState('');

  if (requests.length === 0) return null;

  const open = requests.filter((request) => request.state === 'open');
  const settled = requests.filter((request) => request.state !== 'open');
  const nameOf = (id: string): string => {
    const person = users.find((candidate) => candidate.id === id);
    return person === undefined ? 'Somebody no longer on the system' : userFullName(person);
  };

  const close = (): void => {
    operation.clearError();
    setDeciding(null);
    setNote('');
  };

  const decide = async (): Promise<void> => {
    if (deciding === null) return;
    const ok = await operation.run(async () => {
      await api.resolve(deciding.request.id, { outcome: deciding.outcome, note: note.trim() });
    });
    if (!ok) return;
    close();
    onChanged();
  };

  return (
    <>
      {/*
        The testid is on a wrapper rather than on `Card`, which does not
        forward unknown props to the DOM — a browser test looking for it on the
        card found nothing, which is how this was noticed.
      */}
      <div data-testid="change-requests-panel">
        <Card>
          <CardHeader
            title="Reported problems with this record"
            description="Raised by people who cannot edit the register. The office decides what changes."
            action={
              open.length > 0 ? (
                <Badge tone="amber" dot>
                  {open.length} waiting
                </Badge>
              ) : (
                <Badge tone="neutral">All dealt with</Badge>
              )
            }
          />

          <ul className="mt-4 divide-y divide-steel-100">
            {[...open, ...settled].map((request) => (
              <li key={request.id} className="py-3" data-testid="change-request-row">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={request.state === 'open' ? 'amber' : 'neutral'} size="sm">
                    {changeRequestStateLabel(request.state)}
                  </Badge>
                  <span className="text-xs font-semibold tracking-wide text-steel-500 uppercase">
                    {changeRequestSubjectLabel(request.subject)}
                  </span>
                  <span className="text-xs text-steel-400">
                    {nameOf(request.raisedBy)} · {formatRelative(request.raisedAt)}
                  </span>
                </div>
                <p className="mt-1 text-sm text-steel-900">{request.details}</p>

                {request.state === 'open' ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setDeciding({ request, outcome: 'applied' })}
                      data-testid="change-request-apply"
                    >
                      I have made the change
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setDeciding({ request, outcome: 'declined' })}
                      data-testid="change-request-decline"
                    >
                      Decline
                    </Button>
                  </div>
                ) : (
                  <p className="mt-1 text-xs text-steel-500" data-testid="change-request-resolution">
                    {request.resolvedBy === null ? 'The office' : nameOf(request.resolvedBy)}:{' '}
                    {request.resolutionNote}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Modal
        open={deciding !== null}
        title={deciding?.outcome === 'applied' ? 'Record the change you made' : 'Decline this report'}
        description={
          deciding?.outcome === 'applied'
            ? 'This records your decision beside the report. Edit the record itself on its own tab — nothing here changes the register.'
            : 'Say why, so whoever reported it knows what happened.'
        }
        onClose={close}
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              onClick={() => void decide()}
              loading={operation.running}
              disabled={note.trim().length === 0}
              variant={deciding?.outcome === 'applied' ? 'primary' : 'danger'}
              data-testid="change-request-decision-confirm"
            >
              {deciding?.outcome === 'applied' ? 'Record it' : 'Decline the report'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {deciding !== null && (
            <p className="rounded-[var(--radius-control)] bg-steel-50 px-3 py-2 text-sm text-steel-700">
              {deciding.request.details}
            </p>
          )}
          <TextAreaField
            label={deciding?.outcome === 'applied' ? 'What you changed' : 'Why not'}
            rows={4}
            value={note}
            maxLength={2000}
            onChange={(event) => setNote(event.target.value)}
            data-testid="change-request-note"
          />
          <RuleViolationNotice
            title="That decision was not recorded"
            message={operation.error}
            violations={operation.violations}
          />
        </div>
      </Modal>
    </>
  );
};
