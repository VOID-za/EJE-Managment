'use client';

import { useMemo, useState } from 'react';
import {
  checkCollectionDetails,
  checkReadyForSignature,
  checkRefusalReason,
  evaluateChecklist,
  getJobTypeDefinition,
  signatoryLabelsFor,
  type Job,
} from '@/domain';
import type { JobView } from '@/application/job-view';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Icon,
  TextAreaField,
  TextField,
} from '@/components/ui';
import { ChecklistRunner } from './ChecklistRunner';
import { CompletionReportPanel } from './CompletionReportPanel';
import { JobCardPdfPreview } from './JobCardPdfPreview';
import { JobMediaPanel } from './JobMediaPanel';
import { RuleViolationNotice } from './RuleViolationNotice';
import { SignaturePad } from './SignaturePad';
import { WorkCapturePanel } from './WorkCapturePanel';
import { jobs as api } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';

type StepId = 'completion' | 'checklist' | 'review' | 'collection' | 'signature' | 'issued';

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
  mode = 'complete',
}: {
  readonly view: JobView;
  readonly onClose: () => void;
  readonly onChanged: () => void;
  /** Called once the customer has signed, so the caller can move on to issue. */
  readonly onSigned: (job: Job) => void;
  /**
   * What this run of the wizard is for.
   *
   * `complete` is the technician closing the job out. `correct` is the office
   * putting right a job card the customer refused: the SAME steps and the same
   * panels, because correcting a job card is editing the job, but it ends by
   * returning the card for signature rather than by taking one. The office
   * never signs on the customer's behalf.
   */
  readonly mode?: 'complete' | 'correct';
}) => {
  const { job } = view;
  const operation = useOperation();
  const definition = getJobTypeDefinition(job.jobType);
  const labels = signatoryLabelsFor(job.jobType);
  const correcting = mode === 'correct';

  const steps = useMemo<readonly Step[]>(() => {
    const all: Step[] = [
      {
        id: 'completion',
        title: 'Completion',
        blurb:
          'What was found, what was done, the time, travel and parts it took — and the photographs.',
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
    all.push({
      id: 'review',
      title: 'Review',
      blurb:
        correcting
          ? 'The corrected job card, exactly as the customer will see it. Send it back for signature when it is right.'
          : 'The job card exactly as the customer will receive it. Check it before they sign.',
    });
    // The office corrects and hands back. It does not take the signature, and
    // it does not decide who collects — the technician at the counter does.
    if (correcting) return all;
    // Anything collected from the counter is asked WHO is collecting, because
    // the answer changes what the document shows.
    if (definition.collectedOnCompletion) {
      all.push({
        id: 'collection',
        title: 'Collection',
        blurb: 'Who is collecting — the customer themselves, or a courier on their behalf.',
      });
    }
    all.push(
      {
        id: 'signature',
        title: labels.pageTitle,
        blurb: 'Hand the tablet over once you have checked the summary.',
      },
      {
        id: 'issued',
        title: 'Signed',
        blurb: 'The signed document, before it goes to the customer.',
      },
    );
    return all;
  }, [correcting, definition, labels, view.checklistTemplate]);

  const [index, setIndex] = useState(0);

  /*
   * Clamped, because the step list can shrink underneath the screen.
   *
   * Recording a refusal turns the job into one the office has to correct, and a
   * correction is a shorter sequence than a close-out. For the instant between
   * the job being saved and this component unmounting, the position it was on
   * no longer exists — and reading past the end of the list is how a finished
   * job card ends on a blank error screen.
   */
  const position = Math.min(index, steps.length - 1);
  const step = steps[position]!;
  const isSignatureStep = step.id === 'signature';
  const isIssuedStep = step.id === 'issued';

  /*
   * The signed job, held here until the technician has seen it.
   *
   * `onChanged` refetches, but the point of this step is that nothing moves on
   * until the signed document has been looked at — so the preview is drawn from
   * the job the operation actually returned rather than from whatever the
   * parent has got round to loading.
   */
  const [signedJob, setSignedJob] = useState<Job | null>(null);

  const [firstName, setFirstName] = useState('');
  const [surname, setSurname] = useState('');
  const [strokeData, setStrokeData] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  /*
   * The two outcomes of the signature step, held as ONE choice.
   *
   * `refusing` is not an extra field beside the signature — it swaps what the
   * step is asking for. Selecting it clears the signature entirely and clearing
   * it discards the reason, so the screen can never hold both at once. The
   * operation refuses both-at-once independently; this is the half of it the
   * technician can see.
   */
  const [refusing, setRefusing] = useState(false);
  const [refusalReason, setRefusalReason] = useState('');

  /*
   * The collection, held locally until the step is left.
   *
   * Seeded from the job, because the office records who is expected when the
   * job is raised. Confirmed here, because who actually turns up at the counter
   * is a different question — and the answer decides whether the document
   * carries prices.
   */
  const [courier, setCourier] = useState(job.courierCollection);
  const [waybill, setWaybill] = useState(job.waybillNumber);

  const chooseRefusal = (next: boolean): void => {
    setRefusing(next);
    setErrors({});
    operation.clearError();
    if (next) {
      setFirstName('');
      setSurname('');
      setStrokeData('');
    } else {
      setRefusalReason('');
    }
  };

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
    if (step.id === 'collection') {
      return checkCollectionDetails({
        jobType: job.jobType,
        courierCollection: courier,
        waybillNumber: waybill,
      }).violations.map((violation) => violation.message);
    }
    return [];
  };

  const blocks = blockedBy();

  /*
   * The wizard writes several times in a row — the collection, then the
   * signature — while the screen it is drawn from refetches asynchronously.
   *
   * It used to have to re-read the job before each write, because an operation
   * handed the screen's stale copy would spread a job from before the previous
   * write and silently undo it. That cannot happen now: each command names the
   * job by id and the SERVER loads it, inside the transaction that changes it.
   * The staleness the helper existed to work around is gone with the client's
   * copy of the record.
   */

  const back = (): void => {
    operation.clearError();
    setErrors({});
    // There is no going back past a signature. The customer signed a document;
    // re-opening the pad behind that would be how a second, different signature
    // gets captured against the same acceptance.
    if (isIssuedStep) return;
    if (position === 0) onClose();
    else setIndex(position - 1);
  };

  const forward = async (): Promise<void> => {
    if (blocks.length > 0) return;
    operation.clearError();

    // Leaving the collection step writes the answer to the job, through the
    // operation that owns it, so the preview and the document that follow are
    // drawn from the record rather than from a screen's memory.
    if (step.id === 'collection') {
      const ok = await operation.runFor(() =>
        api.setCollection(job.id, courier, waybill),
      );
      if (ok === null) return;
      onChanged();
    }

    // Moving onto the signature is a real state change, so it happens once,
    // here, through the operation that owns it.
    if (steps[position + 1]?.id === 'signature' && job.status !== 'customer_signature') {
      const ok = await operation.runFor(() => api.startSignature(job.id));
      if (ok === null) return;
      onChanged();
    }
    setIndex(position + 1);
  };

  /**
   * Records the refusal and finishes the close-out.
   *
   * Validated against the same domain rule the operation applies, so the
   * technician is never let through here only to be refused at the end.
   */
  const refuse = async (): Promise<void> => {
    const check = checkRefusalReason(refusalReason);
    if (!check.allowed) {
      setErrors({ refusalReason: check.violations[0]?.message ?? 'A reason is required.' });
      return;
    }
    setErrors({});

    const refused = await operation.runFor(() => api.recordRefusal(job.id, refusalReason));
    if (refused === null) return;
    onChanged();
    onSigned(refused);
  };

  const onLastCorrectionStep = correcting && position === steps.length - 1;

  /**
   * Hands the corrected job card back to the customer.
   *
   * On any earlier step it is simply Continue; on the last one it runs the
   * operation, which resolves the outstanding refusal and returns the job to
   * Customer Signature carrying everything on it.
   */
  const resubmit = async (): Promise<void> => {
    if (!onLastCorrectionStep) {
      await forward();
      return;
    }
    const returned = await operation.runFor(() => api.returnForSignature(job.id, ''));
    if (returned === null) return;
    onChanged();
    onSigned(returned);
  };

  const sign = async (): Promise<void> => {
    if (refusing) {
      await refuse();
      return;
    }
    const next: Record<string, string> = {};
    if (firstName.trim().length === 0) {
      next.firstName = `The ${labels.nameLabel.toLowerCase()} is required.`;
    }
    if (surname.trim().length === 0) {
      next.surname = `The ${labels.surnameLabel.toLowerCase()} is required.`;
    }
    if (strokeData.length === 0) next.signature = 'A signature is required.';
    // The same rule the operation applies, so the pad is never taken on a
    // courier collection that would then be refused for want of a waybill.
    const collection = checkCollectionDetails({
      jobType: job.jobType,
      courierCollection: courier,
      waybillNumber: waybill,
    });
    if (!collection.allowed) {
      next.waybill = collection.violations[0]?.message ?? 'A waybill number is required.';
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    const signed = await operation.runFor(() =>
      api.captureSignature(job.id, {
        customerName: firstName.trim(),
        customerSurname: surname.trim(),
        strokeData,
      }),
    );
    if (signed === null) return;
    setSignedJob(signed);
    onChanged();
    // Onto the signed document, not out of the wizard: the last thing the
    // technician does is look at what the customer just put their name to.
    setIndex(position + 1);
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
          {steps.map((candidate, order) => {
            const done = order < position;
            const active = order === position;
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
                    {done ? <Icon name="check" className="size-3.5" /> : order + 1}
                  </span>
                  {candidate.title}
                </div>
                {order < steps.length - 1 && (
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
            Step {position + 1} of {steps.length} — {step.title}.
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
          {/* The job's own photo panel, not a second one. Photographs belong
              with the write-up they illustrate, and a technician who has to
              leave the close-out to attach them is a technician who attaches
              them from the car park, or not at all. */}
          <JobMediaPanel job={job} users={view.users} editable onChanged={onChanged} />
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
        <Card className="mb-5">
          <CardHeader
            title="The job card"
            description="Rendered by the same generator that produces the issued document, so this is the document itself rather than a drawing of it. Go back and correct anything before the customer signs."
          />
          <div className="mt-4">
            <JobCardPdfPreview view={view} />
          </div>
        </Card>
      )}

      {step.id === 'review' && (
        <Card>
          <CardHeader
            title="Ready for the customer"
            description="Everything captured on this job, in summary."
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

      {step.id === 'collection' && (
        <Card>
          <CardHeader
            title="How is this being collected?"
            description="It decides what the collection document shows. A courier has no reason to see what the customer paid, so their copy carries no prices."
          />

          <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <CollectionChoice
              selected={!courier}
              title="Customer collection"
              blurb="The customer, or somebody from the customer, is collecting. The document shows the prices."
              icon="user"
              onSelect={() => {
                setCourier(false);
                setWaybill('');
                setErrors({});
              }}
            />
            <CollectionChoice
              selected={courier}
              title="Courier collection"
              blurb="A driver is collecting on the customer's behalf. Prices are withheld from their copy, and a waybill number is required."
              icon="box"
              onSelect={() => {
                setCourier(true);
                setErrors({});
              }}
            />
          </div>

          {courier && (
            <div className="mt-5">
              <TextField
                label="Waybill number"
                required
                value={waybill}
                error={errors.waybill}
                onChange={(event) => setWaybill(event.target.value)}
                hint="The courier’s own consignment number. It is what ties this document to the parcel."
              />
            </div>
          )}
        </Card>
      )}

      {step.id === 'issued' && (
        <Card>
          <CardHeader
            title="Signed"
            description="The document as it now stands, with the signature on it. Check it, then hand it on for submission — the customer is emailed their copy from there."
          />
          <div className="mt-4">
            <JobCardPdfPreview
              view={signedJob === null ? view : { ...view, job: signedJob }}
              caption="This is the document that will be issued. Nothing further is captured."
            />
          </div>
        </Card>
      )}

      {step.id === 'signature' && (
        <Card>
          <CardHeader
            title={refusing ? labels.refusedLabel : labels.sectionTitle}
            description={
              refusing
                ? 'The work stands as recorded. Say why the customer would not put their name to it.'
                : labels.sectionDescription
            }
          />

          {/* The signature side of the choice. Hidden outright when the customer
              has refused — a disabled pad beside a refusal invites somebody to
              sign on the customer's behalf. */}
          {!refusing && (
            <>
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

              {/*
                Immediately above the pad, and only for a courier.
                It is the last thing read before the driver signs, which is the
                one moment the number is actually in front of somebody who can
                check it against the consignment in their hand.
              */}
              {definition.collectedOnCompletion && courier && (
                <div className="mt-5">
                  <TextField
                    label="Waybill number"
                    required
                    value={waybill}
                    error={errors.waybill}
                    onChange={(event) => setWaybill(event.target.value)}
                    hint="The courier’s own consignment number. Printed on the delivery note."
                  />
                </div>
              )}

              <div className="mt-5">
                <SignaturePad onChange={setStrokeData} />
                {errors.signature !== undefined && (
                  <p role="alert" className="mt-2 text-sm font-medium text-signal-600">
                    {errors.signature}
                  </p>
                )}
              </div>
            </>
          )}

          {refusing && (
            <div className="mt-5">
              <TextAreaField
                label={labels.refusalTitle}
                required
                rows={5}
                value={refusalReason}
                error={errors.refusalReason}
                hint="Say what happened. This is recorded against the job and sent to a Master."
                onChange={(event) => setRefusalReason(event.target.value)}
              />
            </div>
          )}

          {/*
            The choice itself, below whichever side is showing.

            A checkbox rather than a second button, because the two outcomes are
            one decision and the technician has to be able to change their mind
            before they commit to either.
          */}
          <label
            className={cn(
              'mt-6 flex cursor-pointer items-start gap-3 rounded-[var(--radius-control)] border px-4 py-3 transition-colors',
              refusing
                ? 'border-amber-eje-300 bg-amber-eje-50'
                : 'border-steel-200 bg-surface hover:border-steel-300',
            )}
          >
            <input
              type="checkbox"
              className="mt-0.5 size-5 shrink-0 accent-[var(--color-amber-eje-500)]"
              checked={refusing}
              onChange={(event) => chooseRefusal(event.target.checked)}
            />
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-steel-900">
                {labels.refusedLabel}
              </span>
              <span className="mt-0.5 block text-sm text-steel-600">
                Tick this only if the customer would not sign. The job card is still issued, and a
                Master resolves the refusal first.
              </span>
            </span>
          </label>
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
          {!isIssuedStep && (
            <Button size="lg" variant="secondary" onClick={back} disabled={operation.running}>
              {position === 0 ? 'Leave' : 'Back'}
            </Button>
          )}

          {correcting ? (
            <Button
              size="lg"
              onClick={resubmit}
              loading={operation.running}
              disabled={blocks.length > 0}
              leadingIcon={
                <Icon name={onLastCorrectionStep ? 'signature' : 'chevronRight'} className="size-5" />
              }
            >
              {onLastCorrectionStep ? 'Resubmit for customer signature' : 'Continue'}
            </Button>
          ) : isIssuedStep ? (
            <Button
              size="lg"
              className="ml-auto"
              onClick={() => onSigned(signedJob ?? job)}
              leadingIcon={<Icon name="mail" className="size-5" />}
            >
              Continue to submission
            </Button>
          ) : isSignatureStep ? (
            <Button
              size="lg"
              onClick={sign}
              loading={operation.running}
              /* Disabled until there is a reason, so it cannot be pressed on an
                 empty refusal. The operation enforces the same rule, which is
                 what makes this safe to be a convenience. */
              disabled={refusing && !checkRefusalReason(refusalReason).allowed}
              leadingIcon={
                <Icon name={refusing ? 'warning' : 'signature'} className="size-5" />
              }
            >
              {refusing ? 'Record refusal' : labels.confirmLabel}
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

/** One of the two ways goods leave the counter. A deliberate, tappable choice. */
const CollectionChoice = ({
  selected,
  title,
  blurb,
  icon,
  onSelect,
}: {
  readonly selected: boolean;
  readonly title: string;
  readonly blurb: string;
  readonly icon: 'user' | 'box';
  readonly onSelect: () => void;
}) => (
  <button
    type="button"
    aria-pressed={selected}
    onClick={onSelect}
    className={cn(
      'flex w-full items-start gap-3 rounded-[var(--radius-control)] border p-4 text-left transition-colors',
      selected
        ? 'border-action bg-eje-50/60 ring-1 ring-action'
        : 'border-steel-200 bg-surface hover:border-steel-300',
    )}
  >
    <span
      className={cn(
        'flex size-10 shrink-0 items-center justify-center rounded-full',
        selected ? 'bg-action text-white' : 'bg-steel-100 text-steel-500',
      )}
    >
      <Icon name={icon} className="size-5" />
    </span>
    <span className="min-w-0">
      <span className="block text-sm font-semibold text-steel-900">{title}</span>
      <span className="mt-0.5 block text-sm text-steel-600">{blurb}</span>
    </span>
  </button>
);

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
