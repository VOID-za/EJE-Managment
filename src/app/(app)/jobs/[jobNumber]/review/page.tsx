'use client';

import { useRouter } from 'next/navigation';
import { use, useCallback, useEffect, useState } from 'react';
import {
  can,
  contactFullName,
  deliveryMessage,
  deliveryStateLabel,
  isDelivered,
  refusalAwaitingResolution,
  type DeliveryRecord,
} from '@/domain';
import { isNotFound } from '@/api/client';
import { jobs as api, reads } from '@/api/endpoints';
import type { GeneratedPdf } from '@/services/ports';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  Icon,
  LoadingPanel,
  QueryFailure,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { cn } from '@/lib/cn';
import { downloadBytes } from '@/lib/download';
import { JobCardDocument } from '@/components/jobs/JobCardDocument';
import { PartsCollectionNote } from '@/components/jobs/PartsCollectionNote';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';
import { SignatureRefusalPanel } from '@/components/jobs/SignatureRefusalPanel';
import { useOperation } from '@/hooks/useOperation';
import { useQuery } from '@/hooks/useQuery';
import { useCurrentUser } from '@/providers/AppProvider';

/**
 * Review and submit.
 *
 * The preview below is the actual job card content, rendered from the job
 * record. Submission is confirmed explicitly and, in this demonstration, the
 * customer email is recorded in the simulated outbox rather than sent.
 */
const ReviewJobPage = ({
  params,
}: {
  readonly params: Promise<{ readonly jobNumber: string }>;
}) => {
  const { jobNumber } = use(params);
  const router = useRouter();
  const operation = useOperation();
  const currentUser = useCurrentUser();

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [generated, setGenerated] = useState<GeneratedPdf | null>(null);
  const [submitted, setSubmitted] = useState<{
    fileName: string;
    to: string;
    delivery: DeliveryRecord;
  } | null>(null);

  const viewQuery = useQuery(`job:${jobNumber}:review:${currentUser.id}`, () =>
    reads
      .job(jobNumber)
      .then((screen) => screen.view)
      .catch((cause: unknown) => {
        if (isNotFound(cause)) return null;
        throw cause;
      }),
  );
  const view = viewQuery.data ?? null;
  const jobId = view?.job.id ?? null;

  const storedFinal = view?.job.finalDocument ?? null;

  /**
   * The document descriptor for the header.
   *
   * A closed job's is DERIVED from what was stored when the Master finalised
   * it — no effect, no state, and nothing regenerated. Regenerating would both
   * imply the document could change and append a `pdf_generated` audit entry
   * every time somebody merely looked at an old job card.
   */
  const document: GeneratedPdf | null =
    storedFinal !== null
      ? {
          storageKey: storedFinal.storageKey,
          fileName: storedFinal.fileName,
          pageCount: storedFinal.pageCount,
          generatedAt: storedFinal.generatedAt,
          simulated: storedFinal.simulated,
        }
      : generated;

  // Only a job still in the workflow needs a descriptor produced for it.
  useEffect(() => {
    if (view === null || storedFinal !== null || generated !== null) return;
    let cancelled = false;
    void api
      .generateDocument(view.job.id)
      .then((descriptor) => {
        if (!cancelled) setGenerated(descriptor);
      })
      .catch(() => {
        // A preview that could not be produced is not a failure of the screen;
        // the header simply carries no descriptor.
      });
    return () => {
      cancelled = true;
    };
    // The descriptor depends only on the job identity.
  }, [jobId, view, generated, storedFinal]);

  /**
   * Download the final job card.
   *
   * Retrieves the STORED file — the bytes written when the Master issued it —
   * and writes it to the device under its recorded name. Deliberately not
   * `window.print()`: a print dialog is not a download, it depends on the
   * viewer choosing "Save as PDF", and what it produces is a fresh rendering of
   * the current page rather than the document that was issued.
   */
  const downloadFinal = useCallback(async () => {
    await operation.run(async () => {
      const file = await api.finalDocument(jobNumber);
      downloadBytes(file.bytes, file.fileName, file.contentType);
    });
  }, [operation, jobNumber]);

  if (viewQuery.error !== null) {
    return <QueryFailure code={viewQuery.errorCode} message={viewQuery.error} onRetry={viewQuery.refetch} />;
  }
  if (viewQuery.loading) return <LoadingPanel rows={3} label="Loading job card" />;

  if (view === null) {
    return (
      <EmptyState
        title="Job not found"
        description={`No job with the number ${jobNumber} exists.`}
        icon={<Icon name="jobs" />}
      />
    );
  }

  const { job, customer, contact } = view;
  /*
   * The job card goes to the person on the job.
   *
   * There is deliberately no company-mailbox fallback: email belongs to a named
   * contact, and sending a signed job card to a shared address nobody in
   * particular reads is not delivery to the customer. Where the contact has no
   * address the operation refuses to issue and says whose address is missing,
   * which is a problem the office fixes in one place.
   */
  const customerEmail = contact?.email.trim() ?? '';
  const customerDisplayName = contact === null ? customer.name : contactFullName(contact);

  const isMaster = currentUser.role === 'master';
  const inMasterReview = job.status === 'submitted';
  const awaitingDelivery = job.status === 'awaiting_delivery';
  const closed = job.status === 'closed';

  /*
   * One submission, by whoever finished the job.
   *
   * There is no Master Review in the normal workflow any more: the person who
   * did the work and took the signature submits the job card, and that issues
   * it. `submitted` is only reachable by jobs that entered Master Review before
   * this changed, and a Master can still move those on.
   */
  /*
   * An unresolved signature refusal holds the job card here.
   *
   * Not a permission problem, not a missing signature and not a different
   * status — the work is done, the job is at Review and the document is ready.
   * It waits on a Master resolving why the customer would not sign.
   * `checkReadyForSubmission` refuses it either way; this is what stops the
   * button offering something that would be refused.
   */
  const refusalPending = refusalAwaitingResolution(job);

  const canIssue =
    can(currentUser.role, 'jobs.submit') &&
    !refusalPending &&
    (job.status === 'review' || (inMasterReview && isMaster));

  return (
    <>
      <PageHeader
        title={view?.job.jobType === "parts" ? "Review collection note" : "Review job card"}
        breadcrumbs={[
          { label: 'Jobs', href: '/jobs' },
          { label: job.jobNumber, href: `/jobs/${job.jobNumber}` },
          { label: 'Review' },
        ]}
        description="Check the job card as the customer will receive it, then submit."
        meta={
          document !== null ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 font-mono text-xs text-steel-600">
                <Icon name="document" className="size-3.5" />
                {document.fileName}
              </span>
              <Badge tone="neutral" size="sm">
                {document.pageCount} pages
              </Badge>
              {document.simulated && (
                <Badge tone="amber" size="sm">
                  Simulated document
                </Badge>
              )}
            </div>
          ) : undefined
        }
        actions={
          <Button
            variant="secondary"
            leadingIcon={<Icon name="arrowLeft" className="size-4" />}
            onClick={() => router.push(`/jobs/${job.jobNumber}`)}
          >
            Back to job
          </Button>
        }
      />

      <SignatureRefusalPanel job={job} users={view.users} onChanged={() => viewQuery.refetch()} />

      {/*
        The result, reported from what the provider said.

        "Successfully delivered" appears for a confirmed delivery and for
        nothing else. A pending send says pending, and a failure says the job is
        not closed — because it is not.
      */}
      {submitted !== null && (
        <Card
          className={cn(
            'mb-5',
            isDelivered(submitted.delivery)
              ? 'border-verdant-200 bg-verdant-50'
              : submitted.delivery.state === 'failed'
                ? 'border-signal-200 bg-signal-50'
                : 'border-amber-eje-200 bg-amber-eje-50',
          )}
        >
          <div className="flex items-start gap-3">
            <span
              className={cn(
                'flex size-10 shrink-0 items-center justify-center rounded-full text-white',
                isDelivered(submitted.delivery)
                  ? 'bg-verdant-500'
                  : submitted.delivery.state === 'failed'
                    ? 'bg-signal-500'
                    : 'bg-amber-eje-500',
              )}
            >
              <Icon
                name={isDelivered(submitted.delivery) ? 'check' : 'clock'}
                className="size-5"
              />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-steel-900">
                {deliveryMessage(submitted.delivery, `Job card ${job.jobNumber}`)}
              </p>
              <p className="mt-1 text-sm text-steel-700">
                {submitted.fileName} is stored against the job, so it never has to be signed or
                produced again.
              </p>
              {!isDelivered(submitted.delivery) && (
                <p className="mt-1.5 text-xs text-steel-600">
                  {job.jobNumber} stays open until the customer&rsquo;s copy is confirmed
                  delivered. Confirm or fail the delivery in the Simulated Outbox to see what
                  happens next.
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => router.push(`/jobs/${job.jobNumber}`)}>
                  View job
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => router.push('/notifications?tab=outbox')}
                >
                  Open Simulated Outbox
                </Button>
                {submitted.delivery.state === 'failed' && (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={operation.running}
                    onClick={async () => {
                      const ok = await operation.run(async () => {
                        const again = await api.retryDelivery(job.id);
                        setSubmitted({
                          fileName: again.documentFileName,
                          to: again.emailedTo,
                          delivery: again.delivery,
                        });
                      });
                      if (ok) viewQuery.refetch();
                    }}
                  >
                    Send again
                  </Button>
                )}
              </div>
            </div>
          </div>
        </Card>
      )}

      {operation.error !== null && (
        <div className="mb-5">
          <RuleViolationNotice
            title="This job card could not be submitted"
            message={operation.error}
            violations={operation.violations}
          />
        </div>
      )}

      {job.status === 'review' && submitted === null && (
        <Card
          className={cn(
            'mb-5',
            refusalPending ? 'border-amber-eje-200 bg-amber-eje-50' : 'border-eje-200 bg-eje-50/50',
          )}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardHeader
              title={refusalPending ? 'Awaiting resolution' : 'Ready to submit'}
              description={
                refusalPending
                  ? `The customer refused to sign ${job.jobNumber}. Correct whatever they objected to and resubmit it for signature from the panel above, or issue it without a signature — the technician captures nothing again.`
                  : customerEmail.length === 0
                    ? `No email address is recorded for ${customerDisplayName}. Capture one on the customer's contact before issuing this job card.`
                    : `Submitting generates the ${job.signature !== null ? 'signed ' : ''}job card and emails it to ${customerDisplayName} at ${customerEmail}. ${job.jobNumber} closes once the customer's copy is confirmed delivered.`
              }
            />
            {canIssue && (
              <Button
                size="lg"
                onClick={() => setConfirmOpen(true)}
                leadingIcon={<Icon name="mail" className="size-5" />}
              >
                Submit job card
              </Button>
            )}
          </div>
        </Card>
      )}

      {awaitingDelivery && submitted === null && (
        <Card className="mb-5 border-amber-eje-200 bg-amber-eje-50">
          <CardHeader
            title={`Issued — ${deliveryStateLabel(job.delivery?.state ?? 'pending_delivery').toLowerCase()}`}
            description={deliveryMessage(job.delivery, `Job card ${job.jobNumber}`)}
            action={
              <Badge tone={job.delivery?.state === 'failed' ? 'red' : 'amber'} size="sm" dot>
                Not closed
              </Badge>
            }
          />
          <p className="mt-3 text-xs text-steel-600">
            The signed job card is stored against the job. Re-sending uses that same document — the
            customer is never sent two different job cards, and nothing has to be signed again.
          </p>
          {can(currentUser.role, 'jobs.submit') && (
            <Button
              className="mt-4"
              variant="secondary"
              loading={operation.running}
              leadingIcon={<Icon name="mail" className="size-5" />}
              onClick={async () => {
                const ok = await operation.run(async () => {
                  const again = await api.retryDelivery(job.id);
                  setSubmitted({
                    fileName: again.documentFileName,
                    to: again.emailedTo,
                    delivery: again.delivery,
                  });
                });
                if (ok) viewQuery.refetch();
              }}
            >
              Send to the customer again
            </Button>
          )}
        </Card>
      )}

      {inMasterReview && submitted === null && (
        <Card
          className={cn(
            'mb-5',
            canIssue ? 'border-eje-200 bg-eje-50/50' : 'border-amber-eje-200 bg-amber-eje-50',
          )}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardHeader
              title={canIssue ? 'Ready to issue' : 'With the office'}
              description={
                canIssue
                  ? `Correct anything that needs it on the job, then issue it. The job card will be emailed to ${customerDisplayName} at ${customerEmail} and the job closed.`
                  : 'A Master is reviewing this job card. The customer has not been emailed yet.'
              }
            />
            {canIssue && (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="lg"
                  variant="secondary"
                  onClick={() => router.push(`/jobs/${job.jobNumber}`)}
                  leadingIcon={<Icon name="wrench" className="size-5" />}
                >
                  Edit job
                </Button>
                <Button
                  size="lg"
                  onClick={() => setConfirmOpen(true)}
                  leadingIcon={<Icon name="mail" className="size-5" />}
                >
                  Submit Job Card
                </Button>
              </div>
            )}
          </div>
        </Card>
      )}

      {closed && submitted === null && (
        <Card className="mb-5 border-steel-200 print:hidden">
          <CardHeader
            title="Issued and closed"
            description="The job card the customer holds is the PDF on file below. Read-only, and unaffected by later rate, price or checklist changes."
            action={
              view.job.finalDocument === null ? undefined : (
                <Badge tone="green" size="sm" dot>
                  Final document on file
                </Badge>
              )
            }
          />

          {/* Said plainly, because the two are not the same artefact: the
              stored PDF is what was issued and cannot change, while the card
              rendered below is drawn from the customer record as it stands
              today — so a machine renamed since will read differently here. */}
          <p className="mt-3 text-sm text-steel-600">
            The preview below is drawn from the current customer, site and machine record. Where
            those have been amended since, the document on file is the one the customer received.
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button
              leadingIcon={<Icon name="download" className="size-5" />}
              onClick={downloadFinal}
              loading={operation.running}
            >
              Download Final PDF
            </Button>
            {view.job.finalDocument !== null && (
              <span className="font-mono text-xs text-steel-500">
                {view.job.finalDocument.fileName}
              </span>
            )}
          </div>
        </Card>
      )}

      <div className="eje-document-frame eje-scrollbar overflow-x-auto rounded-[var(--radius-card)] bg-steel-200/60 p-4 sm:p-8">
        {view.job.jobType === 'parts' ? (
          <PartsCollectionNote view={view} />
        ) : (
          <JobCardDocument view={view} />
        )}
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Submit Job Card?"
        message={
          <>
            <p>
              The signed job card will be generated and emailed to {customerDisplayName} at{' '}
              {customerEmail}. This cannot be undone: once submitted, nothing on the job can be
              changed.
            </p>
            <p className="mt-2 text-steel-500">
              {job.jobNumber} closes when the customer&rsquo;s copy is confirmed delivered — not
              when it is sent. If delivery is still pending or fails, the job stays open and can be
              re-sent.
            </p>
            <p className="mt-3 rounded-[var(--radius-control)] bg-amber-eje-50 px-3 py-2.5 text-xs text-amber-eje-700">
              Demonstration mode: no mail leaves the browser. The message is recorded in the
              Simulated Outbox, where delivery is confirmed or failed by hand — which is what the
              provider&rsquo;s delivery report does in production.
            </p>
          </>
        }
        confirmLabel="Submit job card"
        cancelLabel="Cancel"
        busy={operation.running}
        onConfirm={async () => {
          const ok = await operation.run(async () => {
            const result = await api.issue(job.id);
            // Reported from what the PROVIDER said, never from the call having
            // returned. `deliveryMessage` is the only place that phrasing lives.
            setSubmitted({
              fileName: result.documentFileName,
              to: result.emailedTo,
              delivery: result.delivery,
            });
          });
          setConfirmOpen(false);
          if (ok) viewQuery.refetch();
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
};

export default ReviewJobPage;
