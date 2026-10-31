'use client';

import { useState } from 'react';
import {
  CORRECTED_AREAS,
  CORRECTED_AREA_LABEL,
  acknowledgementRequiredFor,
  awaitsAcknowledgement,
  can,
  userFullName,
  type CorrectedArea,
  type Job,
  type JobCorrection,
  type User,
} from '@/domain';
import { Badge, Button, Card, CardHeader, Icon } from '@/components/ui';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';
import { DocumentPreviewDialog } from '@/components/documents/DocumentPreviewDialog';
import { jobs as api } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';
import { useCurrentUser } from '@/providers/AppProvider';
import { downloadBytes } from '@/lib/download';
import { formatDateTime } from '@/lib/format';

/**
 * CORRECTING A JOB CARD EJE HAVE ALREADY ISSUED. BD-02, IMMUT-9, AUD-3.
 *
 * WHAT THIS SCREEN IS NOT: a way back into the job card. Nothing here edits
 * the original — not its contents, not its signature, not its date, not its
 * bytes. Raising a correction adds a NEW record with its own addendum, and the
 * panel says so in the words a Master reads before pressing the button.
 *
 * WHO SEES WHAT. Everybody who may read the issued job card sees the
 * corrections, because the technician who did the work is the person who most
 * needs to know EJE have corrected it. Only a Master is offered the form; the
 * office may record the customer's acknowledgement.
 */
export const JobCorrectionsPanel = ({
  job,
  corrections,
  users,
  onChanged,
}: {
  readonly job: Job;
  readonly corrections: readonly Omit<JobCorrection, 'documentStorageKey'>[];
  readonly users: readonly User[];
  readonly onChanged: () => void;
}) => {
  const currentUser = useCurrentUser();
  const operation = useOperation();
  const mayRaise = can(currentUser.role, 'jobs.raiseCorrection');
  const mayAcknowledge = can(currentUser.role, 'jobs.recordCorrectionAcknowledgement');

  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [narrative, setNarrative] = useState('');
  const [areas, setAreas] = useState<readonly CorrectedArea[]>([]);
  const [acknowledgementRequired, setAcknowledgementRequired] = useState(false);
  const [acknowledging, setAcknowledging] = useState<string | null>(null);
  const [acknowledgedBy, setAcknowledgedBy] = useState('');
  const [method, setMethod] = useState('');
  const [note, setNote] = useState('');

  const nameOf = (id: string): string => {
    const person = users.find((candidate) => candidate.id === id);
    return person === undefined ? 'Somebody no longer on the system' : userFullName(person);
  };

  /*
   * BD-27, approved 27 October 2026: a correction to a price, a quantity or the
   * work described REQUIRES the customer's acknowledgement. The same rule the
   * server enforces, so the form never offers a "No" it would refuse.
   */
  const mustAcknowledge = acknowledgementRequiredFor(areas);
  const askForAcknowledgement = mustAcknowledge || acknowledgementRequired;

  const toggleArea = (area: CorrectedArea): void => {
    setAreas((current) =>
      current.includes(area) ? current.filter((entry) => entry !== area) : [...current, area],
    );
  };

  const raise = async (): Promise<void> => {
    const ok = await operation.run(() =>
      api.raiseCorrection(job.id, {
        reason,
        narrative,
        areas,
        acknowledgementRequired: askForAcknowledgement,
      }),
    );
    if (!ok) return;
    setReason('');
    setNarrative('');
    setAreas([]);
    setAcknowledgementRequired(false);
    setOpen(false);
    onChanged();
  };

  const acknowledge = async (correctionId: string): Promise<void> => {
    const ok = await operation.run(() =>
      api.acknowledgeCorrection(job.id, { correctionId, acknowledgedBy, method, note }),
    );
    if (!ok) return;
    setAcknowledging(null);
    setAcknowledgedBy('');
    setMethod('');
    setNote('');
    onChanged();
  };

  // The correction whose stored PDF is open in the viewer (PDF-VIEW-1).
  const [previewing, setPreviewing] = useState<{ readonly id: string; readonly label: string } | null>(null);

  const download = async (correctionId: string): Promise<void> => {
    await operation.run(async () => {
      const file = await api.correctionDocument(job.jobNumber, correctionId);
      downloadBytes(file.bytes, file.fileName, file.contentType);
    });
  };

  // Nothing to show and nothing to offer: say nothing at all rather than
  // putting an empty card on every closed job.
  if (corrections.length === 0 && !mayRaise) return null;

  return (
    /*
     * THE TEST ID GOES ON A WRAPPER, NOT ON `Card`. `Card` takes `children`,
     * `className` and `padded` and nothing else, so a `data-testid` passed to
     * it is silently dropped — which a smoke step discovered by waiting thirty
     * seconds for an element that was never going to exist.
     */
    <Card className="mb-5">
      <div data-testid="job-corrections">
      <CardHeader
        title="Corrections to this job card"
        description="For a job card already issued to the customer that turns out to be wrong. The signed job card is never edited: a Master raises a numbered correction — a separate addendum PDF linked to the original — saying what was wrong and what is right. A correction that changes a price, a quantity or the work described must be acknowledged by the customer; the office records that acknowledgement here."
        action={
          corrections.length === 0 ? (
            <Badge tone="neutral">None</Badge>
          ) : (
            <Badge tone="amber">
              {corrections.length === 1 ? '1 correction' : `${corrections.length} corrections`}
            </Badge>
          )
        }
      />

      {corrections.length === 0 ? (
        <p className="mt-4 text-sm text-steel-500" data-testid="job-corrections-empty">
          Nothing has been corrected on this job card. Only a Master can raise a correction; the office (Master or
          Coordinator) records the customer&apos;s acknowledgement; anybody who may read the issued job card sees the
          corrections.
        </p>
      ) : (
        <ul className="mt-4 space-y-4" data-testid="job-corrections-list">
          {corrections.map((correction) => (
            <li
              key={correction.id}
              className="rounded-[var(--radius-control)] border border-steel-200 p-3"
              data-testid="job-correction-row"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-semibold text-steel-900">
                    <Icon name="document" className="size-4 shrink-0 text-steel-400" />
                    Correction {correction.sequence}
                    {awaitsAcknowledgement(correction) && (
                      <Badge tone="amber" dot>
                        Awaiting the customer
                      </Badge>
                    )}
                    {correction.acknowledgement === 'recorded' && (
                      <Badge tone="green" dot>
                        Acknowledged
                      </Badge>
                    )}
                  </p>
                  <p className="mt-1 text-xs text-steel-600">{correction.reason}</p>
                  <p className="mt-1 text-sm text-steel-800">{correction.narrative}</p>
                  <p className="mt-1.5 flex flex-wrap gap-1">
                    {correction.areas.map((area) => (
                      <Badge key={area} tone="outline">
                        {CORRECTED_AREA_LABEL[area]}
                      </Badge>
                    ))}
                  </p>
                  <p className="mt-1.5 text-xs text-steel-400">
                    {nameOf(correction.raisedBy)} · {formatDateTime(correction.raisedAt)}
                  </p>
                  {correction.acknowledged !== null && (
                    <p className="mt-1 text-xs text-steel-500">
                      Acknowledged by {correction.acknowledged.acknowledgedBy} (
                      {correction.acknowledged.method}),{' '}
                      {formatDateTime(correction.acknowledged.recordedAt)}
                    </p>
                  )}
                </div>
                <span className="flex shrink-0 flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    leadingIcon={<Icon name="document" className="size-4" />}
                    onClick={() => setPreviewing({ id: correction.id, label: `Correction ${correction.sequence}` })}
                    data-testid="job-correction-preview"
                  >
                    Preview
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => void download(correction.id)}
                    data-testid="job-correction-download"
                  >
                    Download
                  </Button>
                </span>
              </div>

              {/* The office records what the customer said. Once. */}
              {awaitsAcknowledgement(correction) && mayAcknowledge && (
                <div className="mt-3 border-t border-steel-100 pt-3">
                  {acknowledging === correction.id ? (
                    <div className="space-y-2">
                      <input
                        value={acknowledgedBy}
                        maxLength={200}
                        onChange={(event) => setAcknowledgedBy(event.target.value)}
                        placeholder="Who at the customer acknowledged it"
                        className="h-11 w-full rounded-[var(--radius-control)] border border-steel-300 bg-surface px-3 text-sm placeholder:text-steel-400 focus:border-eje-500 focus:ring-2 focus:ring-eje-100 focus:outline-none"
                        data-testid="job-correction-acknowledged-by"
                      />
                      <input
                        value={method}
                        maxLength={200}
                        onChange={(event) => setMethod(event.target.value)}
                        placeholder="How — in person, by telephone, by e-mail"
                        className="h-11 w-full rounded-[var(--radius-control)] border border-steel-300 bg-surface px-3 text-sm placeholder:text-steel-400 focus:border-eje-500 focus:ring-2 focus:ring-eje-100 focus:outline-none"
                        data-testid="job-correction-method"
                      />
                      <textarea
                        value={note}
                        maxLength={2000}
                        rows={2}
                        onChange={(event) => setNote(event.target.value)}
                        placeholder="Anything they said (optional)"
                        className="w-full rounded-[var(--radius-control)] border border-steel-300 bg-surface px-3 py-2 text-sm placeholder:text-steel-400 focus:border-eje-500 focus:ring-2 focus:ring-eje-100 focus:outline-none"
                        data-testid="job-correction-note"
                      />
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          size="sm"
                          loading={operation.running}
                          onClick={() => void acknowledge(correction.id)}
                          data-testid="job-correction-acknowledge-save"
                        >
                          Record it
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={() => setAcknowledging(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                      <p className="text-xs text-steel-400">
                        This is recorded once and is not rewritten afterwards.
                      </p>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => setAcknowledging(correction.id)}
                      data-testid="job-correction-acknowledge"
                    >
                      Record the customer’s acknowledgement
                    </Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {mayRaise && (
        <div className="mt-4 border-t border-steel-100 pt-3">
          {open ? (
            <div className="space-y-3">
              {/*
                SAID BEFORE THE BUTTON, not after it. A Master about to correct
                a document a customer holds should read what will and will not
                happen.
              */}
              <p className="rounded-[var(--radius-control)] border border-steel-200 bg-steel-50 px-3 py-2 text-xs leading-relaxed text-steel-700">
                The issued job card, its signature and its date are <strong>not changed</strong>.
                This produces a separate addendum, numbered and linked to the original, which the
                customer reads beside the job card they already hold.
              </p>

              <div>
                <label
                  className="text-xs font-semibold tracking-wide text-steel-500 uppercase"
                  htmlFor="correction-reason"
                >
                  Why the original is wrong
                </label>
                <textarea
                  id="correction-reason"
                  value={reason}
                  maxLength={2000}
                  rows={2}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="The labour hours were captured against the wrong rate."
                  className="mt-1 w-full rounded-[var(--radius-control)] border border-steel-300 bg-surface px-3 py-2 text-sm placeholder:text-steel-400 focus:border-eje-500 focus:ring-2 focus:ring-eje-100 focus:outline-none"
                  data-testid="correction-reason"
                />
              </div>

              <div>
                <label
                  className="text-xs font-semibold tracking-wide text-steel-500 uppercase"
                  htmlFor="correction-narrative"
                >
                  What the correction says
                </label>
                <textarea
                  id="correction-narrative"
                  value={narrative}
                  maxLength={8000}
                  rows={3}
                  onChange={(event) => setNarrative(event.target.value)}
                  placeholder="Three hours were charged at the after-hours rate and should have been normal time."
                  className="mt-1 w-full rounded-[var(--radius-control)] border border-steel-300 bg-surface px-3 py-2 text-sm placeholder:text-steel-400 focus:border-eje-500 focus:ring-2 focus:ring-eje-100 focus:outline-none"
                  data-testid="correction-narrative"
                />
              </div>

              <fieldset>
                <legend className="text-xs font-semibold tracking-wide text-steel-500 uppercase">
                  Which parts of the job card are affected
                </legend>
                <div className="mt-1 flex flex-wrap gap-2">
                  {CORRECTED_AREAS.map((area) => (
                    <Button
                      key={area}
                      type="button"
                      size="sm"
                      variant={areas.includes(area) ? 'primary' : 'secondary'}
                      onClick={() => toggleArea(area)}
                      data-testid={`correction-area-${area}`}
                    >
                      {CORRECTED_AREA_LABEL[area]}
                    </Button>
                  ))}
                </div>
              </fieldset>

              <fieldset>
                <legend className="text-xs font-semibold tracking-wide text-steel-500 uppercase">
                  Does the customer have to acknowledge it?
                </legend>
                <div className="mt-1 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={askForAcknowledgement ? 'primary' : 'secondary'}
                    onClick={() => setAcknowledgementRequired(true)}
                    data-testid="correction-acknowledgement-required"
                  >
                    Yes — ask them to confirm
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={askForAcknowledgement ? 'secondary' : 'primary'}
                    disabled={mustAcknowledge}
                    onClick={() => setAcknowledgementRequired(false)}
                    data-testid="correction-acknowledgement-not-required"
                  >
                    No
                  </Button>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-steel-400">
                  {mustAcknowledge
                    ? 'Required: this correction changes a price, a quantity or the work described, and EJE require the customer to acknowledge those.'
                    : 'The addendum says which of these it is, either way. For these areas EJE leave it to your judgement, and it is recorded as such.'}
                </p>
              </fieldset>

              {operation.error !== null && (
                <RuleViolationNotice
                  title="That correction was not raised"
                  message={operation.error}
                  violations={operation.violations}
                />
              )}

              <div className="flex gap-2">
                <Button
                  type="button"
                  loading={operation.running}
                  onClick={() => void raise()}
                  data-testid="correction-save"
                >
                  Raise the correction
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
              onClick={() => setOpen(true)}
              data-testid="correction-open"
            >
              <Icon name="document" className="size-4" />
              Raise a correction
            </Button>
          )}
        </div>
      )}
      </div>
      {/* The correction's stored PDF, in the application's viewer (PDF-VIEW-1). */}
      <DocumentPreviewDialog
        open={previewing !== null}
        title={`${job.jobNumber} — ${previewing?.label ?? 'Correction'}`}
        description="The correction document as it was stored. Looking at it changes nothing."
        loadPdf={async () => {
          const file = await api.correctionDocument(job.jobNumber, previewing?.id ?? '');
          return { bytes: file.bytes, fileName: file.fileName };
        }}
        onClose={() => setPreviewing(null)}
      />
    </Card>
  );
};
