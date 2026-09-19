'use client';

import { useMemo, useState } from 'react';
import {
  checkReadyForSignature,
  evaluateChecklist,
  getJobTypeDefinition,
  signatoryLabelsFor,
  type Job,
} from '@/domain';
import { captureSignature, startSignature } from '@/application/job-operations';
import type { JobView } from '@/application/job-view';
import { Badge, Button, Card, CardHeader, Icon, TextField } from '@/components/ui';
import { ChecklistRunner } from './ChecklistRunner';
import { CompletionReportPanel } from './CompletionReportPanel';
import { RuleViolationNotice } from './RuleViolationNotice';
import { SignaturePad } from './SignaturePad';
import { WorkCapturePanel } from './WorkCapturePanel';
import { useOperation } from '@/hooks/useOperation';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';

type StepId = 'completion' | 'checklist' | 'review' | 'signature';

interface Step {
  readonly id: StepId;
  readonly title: string;
  readonly blurb: string;
}

/**
 * Closing a job, as one guided sequence.
 *
 * Complete Job used to move the status and leave the technician on the job
 * screen to find the rest for themselves — the write-up on one tab, the
 * checklist on another, the signature behind a button, each with its own idea
 * of what still had to be done. On a tablet, in a workshop, that is a way to
 * leave a job half finished.
 *
 * So this is the whole close-out in one place, one task per screen, with the
 * customer and machine always on view. It is a WRAPPER, not a second workflow:
 * every step renders the component that already owns that job and calls the
 * same operation. Nothing here validates, prices, stores or sends anything
 * itself — `checkReadyForSignature` and the operations remain the authority,
 * so the wizard cannot drift from what the system will actually accept.
 */
export const CompleteJobWizard = ({
  view,
  onClose,
  onChanged,
  onSigned,
}: {
  readonly view: JobView;
  readonly onClose: () => void;
  readonly onChanged: () => void;
  /** Called once the customer has signed, so the caller can move on to issue. */
  readonly onSigned: (job: Job) => void;
}) => {
  const { job } = view;
  const operation = useOperation();
  const definition = getJobTypeDefinition(job.jobType);
  const labels = signatoryLabelsFor(job.jobType);

  const steps = useMemo<readonly Step[]>(() => {
    const all: Step[] = [
      {
        id: 'completion',
        title: 'Completion',
        blurb: 'What was found, what was done, and the time, travel and parts it took.',
      },
    ];
    // Only where the job type actually requires one. A breakdown or a test and
    // repair has no checklist, so it is not given an empty step to walk past.
    if (definition.checklistRequired && view.checklistTemplate !== null) {
      all.push({
        id: 'checklist',
        title: 'Checklist',
        blurb: `The mandatory ${definition.label.toLowerCase()} checklist.`,
      });
    }
    all.push(
      { id: 'review', title: 'Review', blurb: 'Check it over before the customer signs.' },
      {
        id: 'signature',
        title: labels.pageTitle,
        blurb: 'Hand the tablet over once you have checked the summary.',
      },
    );
    return all;
  }, [definition, labels, view.checklistTemplate]);

  const [index, setIndex] = useState(0);
  const step = steps[index]!;
  const isLast = index === steps.length - 1;

  const [firstName, setFirstName] = useState('');
  const [surname, setSurname] = useState('');
  const [strokeData, setStrokeData] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const readiness = checkReadyForSignature(job);
  const checklist =
    view.checklistTemplate === null
      ? null
      : evaluateChecklist(view.checklistTemplate, job.checklist);

  /**
   * Whether this step may be left.
   *
   * Asked of the domain, not decided here: the Continue button and the
   * operation that eventually runs are held to the same rule, so a technician
   * is never allowed forward into a step that will refuse them at the end.
   */
  const blockedBy = (): readonly string[] => {
    if (step.id === 'completion') {
      return readiness.violations
        .filter((violation) => !violation.code.startsWith('checklist'))
        .map((violation) => violation.message);
    }
    if (step.id === 'checklist') {
      return readiness.violations
        .filter((violation) => violation.code.startsWith('checklist'))
        .map((violation) => violation.message);
    }
    if (step.id === 'review') return readiness.violations.map((violation) => violation.message);
    return [];
  };

  const blocks = blockedBy();

  const back = (): void => {
    operation.clearError();
    setErrors({});
    if (index === 0) onClose();
    else setIndex((current) => current - 1);
  };

  const forward = async (): Promise<void> => {
    if (blocks.length > 0) return;
    operation.clearError();

    // Moving onto the signature is a real state change, so it happens once,
    // here, through the operation that owns it.
    if (steps[index + 1]?.id === 'signature' && job.status !== 'customer_signature') {
      const ok = await operation.run((context) => startSignature(context, job));
      if (!ok) return;
      onChanged();
    }
    setIndex((current) => current + 1);
  };

  const sign = async (): Promise<void> => {
    const next: Record<string, string> = {};
    if (firstName.trim().length === 0) {
      next.firstName = `The ${labels.nameLabel.toLowerCase()} is required.`;
    }
    if (surname.trim().length === 0) {
      next.surname = `The ${labels.surnameLabel.toLowerCase()} is required.`;
    }
    if (strokeData.length === 0) next.signature = 'A signature is required.';
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    const signed = await operation.runFor((context) =>
      captureSignature(context, job, {
        customerName: firstName.trim(),
        customerSurname: surname.trim(),
        strokeData,
      }),
    );
    if (signed === null) return;
    onChanged();
    onSigned(signed);
  };

  return (
    <div className="space-y-5">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold tracking-wide text-steel-500 uppercase">
              Complete job {job.jobNumber}
            </p>
            {/* The context never leaves the screen: on a handed-over tablet the
                technician must be able to see whose machine this is. */}
            <p className="mt-1 text-sm font-semibold text-steel-900">{view.customer.name}</p>
            <p className="text-sm text-steel-600">
              {[
                view.site.name,
                view.machine === null
                  ? null
                  : `${view.machine.manufacturer} ${view.machine.model}`,
              ]
                .filter((part) => part !== null)
                .join(' · ')}
            </p>
          </div>
          <Button variant="ghost" onClick={onClose}>
            Leave the wizard
          </Button>
        </div>

        <ol className="eje-scrollbar mt-5 flex min-w-max items-center gap-1 overflow-x-auto pb-1">
          {steps.map((candidate, position) => {
            const done = position < index;
            const active = position === index;
            return (
              <li key={candidate.id} className="flex items-center gap-1">
                <div
                  className={cn(
                    'flex items-center gap-2 rounded-full py-2 pr-4 pl-2 text-sm font-semibold whitespace-nowrap',
                    active
                      ? 'bg-action text-white'
                      : done
                        ? 'bg-verdant-50 text-verdant-700'
                        : 'bg-steel-100 text-steel-400',
                  )}
                >
                  <span
                    className={cn(
                      'flex size-6 items-center justify-center rounded-full text-xs font-bold',
                      active
                        ? 'bg-white/25 text-white'
                        : done
                          ? 'bg-verdant-500 text-white'
                          : 'bg-surface text-steel-400',
                    )}
                  >
                    {done ? <Icon name="check" className="size-3.5" /> : position + 1}
                  </span>
                  {candidate.title}
                </div>
                {position < steps.length - 1 && (
                  <span
                    className={cn('h-px w-5', done ? 'bg-verdant-300' : 'bg-steel-200')}
                    aria-hidden="true"
                  />
                )}
              </li>
            );
          })}
        </ol>

        <p className="mt-4 text-sm text-steel-600">
          <span className="font-semibold text-steel-800">
            Step {index + 1} of {steps.length} — {step.title}.
          </span>{' '}
          {step.blurb}
        </p>
      </Card>

      {operation.error !== null && (
        <RuleViolationNotice
          title="That step could not be completed"
          message={operation.error}
          violations={operation.violations}
        />
      )}

      {step.id === 'completion' && (
        <div className="space-y-5">
          <CompletionReportPanel job={job} editable onChanged={onChanged} />
          <WorkCapturePanel
            job={job}
            settings={view.settings}
            users={view.users}
            editable
            onChanged={onChanged}
          />
        </div>
      )}

      {step.id === 'checklist' && view.checklistTemplate !== null && (
        <ChecklistRunner
          job={job}
          template={view.checklistTemplate}
          editable
          onChanged={onChanged}
        />
      )}

      {step.id === 'review' && (
        <Card>
          <CardHeader
            title="Ready for the customer"
            description="Everything captured on this job. Go back to correct anything before it is signed for."
          />
          <dl className="mt-5 grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            {[
              { label: 'Customer', value: view.customer.name },
              { label: 'Site', value: view.site.name },
              {
                label: 'Machine',
                value:
                  view.machine === null
                    ? 'Not applicable'
                    : `${view.machine.manufacturer} ${view.machine.model}`,
              },
              { label: 'Job type', value: definition.label },
              { label: 'Order number', value: job.orderNumber || 'Not supplied' },
              { label: 'Reference', value: job.referenceNumber || 'Not supplied' },
              { label: 'Scheduled', value: formatDate(job.scheduledDate) },
              {
                label: 'Checklist',
                value:
                  checklist === null
                    ? 'Not required for this job type'
                    : `${checklist.answered} of ${checklist.total} answered${
                        checklist.failedItems > 0 ? `, ${checklist.failedItems} failed` : ''
                      }`,
              },
            ].map((row) => (
              <div key={row.label}>
                <dt className="text-xs font-semibold tracking-wide text-steel-500 uppercase">
                  {row.label}
                </dt>
                <dd className="mt-0.5 text-sm text-steel-800">{row.value}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-5 border-t border-steel-100 pt-4">
            <p className="text-xs font-semibold tracking-wide text-steel-500 uppercase">
              Work performed
            </p>
            <p className="mt-1 text-sm leading-relaxed whitespace-pre-wrap text-steel-800">
              {job.completionReport.workPerformed}
            </p>
          </div>

          {/* Captured work is listed only where there IS any: an empty section
              explaining what could have been captured is furniture on a review
              screen, and this is the last look before a customer signs. */}
          {job.labour.length > 0 && (
            <ReviewLines
              title="Labour"
              lines={job.labour.map(
                (entry) => `${entry.hours.toFixed(2)} hrs — ${entry.description || 'No description'}`,
              )}
            />
          )}
          {job.travel.length > 0 && (
            <ReviewLines
              title="Travel"
              lines={job.travel.map(
                (entry) => `${entry.kilometres} km — ${entry.description || 'No description'}`,
              )}
            />
          )}
          {job.parts.length > 0 && (
            <ReviewLines
              title="Parts"
              lines={job.parts.map(
                (entry) => `${entry.quantity} × ${entry.partNumber} — ${entry.description}`,
              )}
            />
          )}
          {job.notes.length > 0 && (
            <ReviewLines
              title="Notes"
              lines={job.notes.filter((note) => !note.internal).map((note) => note.body)}
            />
          )}
        </Card>
      )}

      {step.id === 'signature' && (
        <Card>
          <CardHeader title={labels.sectionTitle} description={labels.sectionDescription} />
          <p className="mt-4 rounded-[var(--radius-control)] bg-steel-50 px-4 py-3 text-sm font-medium text-steel-800">
            {labels.declaration}
          </p>

          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <TextField
              label={labels.nameLabel}
              required
              value={firstName}
              error={errors.firstName}
              onChange={(event) => setFirstName(event.target.value)}
            />
            <TextField
              label={labels.surnameLabel}
              required
              value={surname}
              error={errors.surname}
              onChange={(event) => setSurname(event.target.value)}
            />
          </div>

          <div className="mt-5">
            <SignaturePad onChange={setStrokeData} />
            {errors.signature !== undefined && (
              <p role="alert" className="mt-2 text-sm font-medium text-signal-600">
                {errors.signature}
              </p>
            )}
          </div>
        </Card>
      )}

      {blocks.length > 0 && (
        <RuleViolationNotice
          title="Still to do before this step is finished"
          message="The system will not accept the job card until these are done."
          violations={blocks.map((message) => ({ code: 'incomplete', message }))}
        />
      )}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button size="lg" variant="secondary" onClick={back} disabled={operation.running}>
            {index === 0 ? 'Leave' : 'Back'}
          </Button>

          {isLast ? (
            <Button
              size="lg"
              onClick={sign}
              loading={operation.running}
              leadingIcon={<Icon name="signature" className="size-5" />}
            >
              {labels.confirmLabel}
            </Button>
          ) : (
            <Button
              size="lg"
              onClick={forward}
              loading={operation.running}
              disabled={blocks.length > 0}
            >
              Continue
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
};

const ReviewLines = ({
  title,
  lines,
}: {
  readonly title: string;
  readonly lines: readonly string[];
}) => {
  if (lines.length === 0) return null;
  return (
    <div className="mt-5 border-t border-steel-100 pt-4">
      <div className="flex items-center gap-2">
        <p className="text-xs font-semibold tracking-wide text-steel-500 uppercase">{title}</p>
        <Badge tone="outline" size="sm">
          {lines.length}
        </Badge>
      </div>
      <ul className="mt-2 space-y-1">
        {lines.map((line, position) => (
          <li key={`${title}-${position}`} className="text-sm text-steel-800">
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
};
