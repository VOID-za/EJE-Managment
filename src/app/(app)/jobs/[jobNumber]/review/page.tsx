'use client';

import { useRouter } from 'next/navigation';
import { use, useEffect, useState } from 'react';
import { contactFullName } from '@/domain';
import {
  generateJobCardDocument,
  submitForMasterReview,
  submitJobCard,
} from '@/application/job-operations';
import { loadJobView } from '@/application/job-view';
import type { GeneratedPdf } from '@/services/ports';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Icon,
  LoadingPanel,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { cn } from '@/lib/cn';
import { JobCardDocument } from '@/components/jobs/JobCardDocument';
import { PartsCollectionNote } from '@/components/jobs/PartsCollectionNote';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';
import { useOperation } from '@/hooks/useOperation';
import { useQuery } from '@/hooks/useQuery';
import { useApp, useCurrentUser } from '@/providers/AppProvider';

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
  const { operationContext } = useApp();
  const currentUser = useCurrentUser();

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [document, setDocument] = useState<GeneratedPdf | null>(null);
  const [submitted, setSubmitted] = useState<{ fileName: string; to: string } | null>(null);

  const viewQuery = useQuery(`job:${jobNumber}:review`, (repos) => loadJobView(repos, jobNumber));
  const view = viewQuery.data ?? null;
  const jobId = view?.job.id ?? null;

  // Generate the document descriptor once the job has loaded, so the preview
  // header can show the real file name and page count.
  useEffect(() => {
    if (view === null || document !== null) return;
    let cancelled = false;
    void generateJobCardDocument(operationContext(), view.job).then((generated) => {
      if (!cancelled) setDocument(generated);
    });
    return () => {
      cancelled = true;
    };
    // The descriptor depends only on the job identity.
  }, [jobId, view, document, operationContext]);

  if (viewQuery.error !== null) {
    return <ErrorState message={viewQuery.error} onRetry={viewQuery.refetch} />;
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
  const customerEmail = contact?.email ?? customer.email;
  const customerDisplayName = contact === null ? customer.name : contactFullName(contact);

  const isMaster = currentUser.role === 'master';
  const awaitingHandOver = job.status === 'review';
  const inMasterReview = job.status === 'submitted';
  const closed = job.status === 'closed';

  // Two distinct submissions. The technician hands the job to the office; only a
  // Master issues it to the customer.
  const canHandOver = awaitingHandOver;
  const canIssue = inMasterReview && isMaster;

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

      {submitted !== null && (
        <Card className="mb-5 border-verdant-200 bg-verdant-50">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-verdant-500 text-white">
              <Icon name="check" className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-verdant-700">
                {job.jobNumber} submitted and closed
              </p>
              <p className="mt-1 text-sm text-steel-700">
                {submitted.fileName} was queued for delivery to {submitted.to}.
              </p>
              <p className="mt-1.5 text-xs text-steel-500">
                Demonstration mode: the email is recorded in the Simulated Outbox on the
                Notifications screen. No message was transmitted.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => router.push(`/jobs/${job.jobNumber}`)}>
                  View closed job
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => router.push('/notifications?tab=outbox')}
                >
                  Open Simulated Outbox
                </Button>
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

      {canHandOver && submitted === null && (
        <Card className="mb-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardHeader
              title="Ready to hand over"
              description="The office reviews and approves this job card before the customer receives it. Nothing is emailed at this step."
            />
            <Button
              size="lg"
              onClick={() => setConfirmOpen(true)}
              leadingIcon={<Icon name="check" className="size-5" />}
            >
              Submit for Master Review
            </Button>
          </div>
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
              title={canIssue ? 'Master review' : 'With the office for review'}
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
        <Card className="mb-5 border-steel-200">
          <CardHeader
            title="Issued and closed"
            description={`This job card was issued to the customer and closed. It is read-only.`}
          />
        </Card>
      )}

      <div className="eje-scrollbar overflow-x-auto rounded-[var(--radius-card)] bg-steel-200/60 p-4 sm:p-8">
        {view.job.jobType === 'parts' ? (
          <PartsCollectionNote view={view} />
        ) : (
          <JobCardDocument view={view} />
        )}
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title={canIssue ? 'Submit Job Card?' : 'Submit for Master Review?'}
        message={
          canIssue ? (
            <>
              <p>
                Once submitted, this job will be closed and the signed job card will be emailed to
                the customer.
              </p>
              <p className="mt-3 rounded-[var(--radius-control)] bg-amber-eje-50 px-3 py-2.5 text-xs text-amber-eje-700">
                Demonstration mode: no email is actually sent. The message is recorded in the
                Simulated Outbox so you can see exactly what production would transmit.
              </p>
            </>
          ) : (
            <>
              <p>
                {job.jobNumber} will be handed to the office for review. The customer is{' '}
                <span className="font-semibold">not</span> emailed at this step.
              </p>
              <p className="mt-2 text-steel-500">
                A Master checks and corrects the job card, then issues it to the customer.
              </p>
            </>
          )
        }
        confirmLabel={canIssue ? 'Submit' : 'Submit for review'}
        cancelLabel="Cancel"
        busy={operation.running}
        onConfirm={async () => {
          const ok = await operation.run(async (context) => {
            if (canIssue) {
              const result = await submitJobCard(context, job, customerEmail, customerDisplayName);
              setSubmitted({ fileName: result.documentFileName, to: result.emailedTo });
            } else {
              await submitForMasterReview(context, job);
              setSubmitted(null);
            }
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
