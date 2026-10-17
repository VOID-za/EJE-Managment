'use client';

import { useState } from 'react';
import Link from 'next/link';
import { can, jobStatusLabel, type CaptureResolution } from '@/domain';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  LoadingPanel,
  Modal,
  QueryFailure,
  SelectField,
  TextAreaField,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';
import { captures } from '@/api/endpoints';
import type { CaptureReferralRow } from '@/application/capture-referral-view';
import { useQuery } from '@/hooks/useQuery';
import { useOperation } from '@/hooks/useOperation';
import { useCurrentUser } from '@/providers/AppProvider';
import { formatDateTime, formatRelative } from '@/lib/format';

/**
 * WORK A TABLET COULD NOT GET ONTO A JOB. THE OFFICE'S SCREEN. BD-15.
 *
 * WHAT IT IS FOR, in one sentence: a technician worked three hours in a plant
 * basement, the job was signed or closed or transferred before their tablet
 * could reach the server, and somebody has to decide what happens to those
 * hours. Before this screen existed that decision depended on the technician
 * remembering to mention it.
 *
 * TWO DECISIONS, AND NEITHER IS A SHRUG.
 *
 *   - **Apply it to the job.** Runs the ordinary capture with the office's own
 *     authority, through every rule a line captured by hand goes through. If
 *     the job still refuses it — signed, closed — the refusal comes back in the
 *     server's own words and the referral stays open, because nothing happened.
 *   - **No action, with a reason.** The honest outcome for hours on a job that
 *     has been invoiced. The reason is required: "we are not doing anything
 *     about your three hours" is only an answer if it says why.
 *
 * WHAT IT DOES NOT OFFER: editing the capture. The hours, the kilometres and
 * the note are what the technician recorded, and an office screen that could
 * quietly change them before applying them would make the audit trail say
 * something that never happened. If the details are wrong, the answer is no
 * action with a reason, and a conversation.
 */
const CapturesPage = () => {
  const currentUser = useCurrentUser();
  const operation = useOperation();
  const [resolving, setResolving] = useState<CaptureReferralRow | null>(null);
  const [resolution, setResolution] = useState<CaptureResolution>('applied');
  const [note, setNote] = useState('');

  const query = useQuery(`captures:referrals:${currentUser.id}`, () => captures.referrals());

  if (!can(currentUser.role, 'captures.resolveReferral')) {
    return (
      <EmptyState
        title="You do not have access to this"
        description="Work referred from a tablet is dealt with by the office."
        icon={<Icon name="warning" />}
      />
    );
  }

  if (query.error !== null && query.data === null) {
    return <QueryFailure code={query.errorCode} message={query.error} onRetry={query.refetch} />;
  }

  const rows = query.data?.rows ?? [];
  const open = rows.filter((row) => row.referral.state === 'open');
  const resolved = rows.filter((row) => row.referral.state === 'resolved');

  const submit = async () => {
    if (resolving === null) return;
    const ok = await operation.run(() =>
      captures.resolve(resolving.referral.id, { resolution, note: note.trim() }),
    );
    if (ok) {
      setResolving(null);
      setNote('');
      setResolution('applied');
      query.refetch();
    }
  };

  return (
    <>
      <PageHeader
        title="Field Captures"
        description="Work a technician captured with no signal that the job would not take. Each one needs a decision."
        breadcrumbs={[{ label: 'Field Captures' }]}
      />

      {operation.error !== null && (
        <RuleViolationNotice
          title="That capture was not resolved"
          message={operation.error}
          violations={operation.violations}
        />
      )}

      {query.loading ? (
        <LoadingPanel rows={4} label="Loading referred captures" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="Nothing waiting"
          description="When a tablet captures work offline that the job will not take, it appears here for the office to deal with."
          icon={<Icon name="check" />}
        />
      ) : (
        <div className="space-y-5">
          <section>
            <h2 className="mb-2 text-sm font-semibold text-steel-900">
              Waiting for a decision{' '}
              <span className="tabular ml-1 text-steel-400">{open.length}</span>
            </h2>
            {open.length === 0 ? (
              <Card>
                <p className="text-sm text-steel-500">
                  Nothing is waiting. Everything referred from the field has been dealt with.
                </p>
              </Card>
            ) : (
              <ul className="space-y-3" data-testid="open-referrals">
                {open.map((row) => (
                  <li key={row.referral.id}>
                    <Card>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge tone="red" size="sm">
                              Not on the job
                            </Badge>
                            <Link
                              href={`/jobs/${row.jobNumber}`}
                              className="font-mono text-sm font-semibold hover:underline"
                            >
                              {row.jobNumber}
                            </Link>
                            <span className="text-xs text-steel-500">
                              {jobStatusLabel(row.jobStatus)}
                            </span>
                          </div>
                          <p className="mt-1 text-sm font-medium text-steel-900">
                            {row.referral.summary}
                          </p>
                          <p className="text-xs text-steel-500">
                            {row.technicianName} captured it{' '}
                            {formatRelative(row.referral.capturedAt)} · referred{' '}
                            {formatRelative(row.referral.referredAt)}
                          </p>
                          {/* THE SERVER'S OWN WORDS. Paraphrasing the refusal
                              would hide the only thing that explains why the
                              work is not on the job. */}
                          <p className="mt-1 text-sm font-medium text-signal-700">
                            {row.referral.refusalMessage}
                          </p>
                        </div>
                        <Button
                          type="button"
                          onClick={() => {
                            setResolving(row);
                            setResolution('applied');
                            setNote('');
                            operation.clearError();
                          }}
                        >
                          Decide
                        </Button>
                      </div>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {resolved.length > 0 && (
            <section>
              <h2 className="mb-2 text-sm font-semibold text-steel-900">
                Dealt with <span className="tabular ml-1 text-steel-400">{resolved.length}</span>
              </h2>
              <Card padded={false}>
                <ul className="divide-y divide-steel-100" data-testid="resolved-referrals">
                  {resolved.map((row) => (
                    <li key={row.referral.id} className="px-5 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          tone={row.referral.resolution === 'applied' ? 'green' : 'neutral'}
                          size="sm"
                        >
                          {row.referral.resolution === 'applied' ? 'Applied' : 'No action'}
                        </Badge>
                        <span className="font-mono text-xs">{row.jobNumber}</span>
                        <span className="text-sm text-steel-700">{row.referral.summary}</span>
                      </div>
                      <p className="mt-1 text-xs text-steel-500">
                        {row.resolvedByName ?? 'The office'} ·{' '}
                        {row.referral.resolvedAt === null
                          ? ''
                          : formatDateTime(row.referral.resolvedAt)}
                        {row.referral.resolutionNote.length > 0 &&
                          ` · ${row.referral.resolutionNote}`}
                      </p>
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          )}
        </div>
      )}

      <Modal
        open={resolving !== null}
        title="What happens to this capture?"
        description={
          resolving === null
            ? ''
            : `${resolving.technicianName} captured ${resolving.referral.summary} for ${resolving.jobNumber}.`
        }
        onClose={() => setResolving(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setResolving(null)} disabled={operation.running}>
              Cancel
            </Button>
            <Button onClick={submit} loading={operation.running}>
              Record the decision
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <SelectField
            label="Decision"
            value={resolution}
            onChange={(event) => setResolution(event.target.value as CaptureResolution)}
            options={[
              { value: 'applied', label: 'Apply it to the job' },
              { value: 'no_action', label: 'No action — record why' },
            ]}
            hint={
              resolution === 'no_action'
                ? 'Nothing further happens to the capture. The reason is kept against it and the technician can see it.'
                : resolving?.referral.action === 'answer_checklist'
                  ? 'Answered onto the job through the ordinary operation. A checklist answer REPLACES whatever answer is on the job now, and your decision is recorded against it — so read the refusal below first. An answer can never be moved onto a different version of the checklist.'
                  : 'Captured onto the job through the ordinary operation, with every rule that applies to a line captured by hand. If the job refuses it, nothing happens and you will be told why.'
            }
          />
          <TextAreaField
            label={resolution === 'no_action' ? 'Reason (required)' : 'Note (optional)'}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={3}
            placeholder={
              resolution === 'no_action'
                ? 'e.g. The job was invoiced on the 14th; the hours were added to EJE-1071 instead.'
                : ''
            }
          />
          {resolving !== null && (
            <p className="rounded-[var(--radius-control)] bg-steel-50 px-3 py-2 text-xs text-steel-600">
              The server refused this capture because:{' '}
              <span className="font-medium">{resolving.referral.refusalMessage}</span>
            </p>
          )}
        </div>
      </Modal>
    </>
  );
};

export default CapturesPage;
