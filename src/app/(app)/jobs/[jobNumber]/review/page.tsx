'use client';

import { useRouter } from 'next/navigation';
import { use, useEffect, useState } from 'react';
import { contactFullName } from '@/domain';
import { generateJobCardDocument, submitJob } from '@/application/job-operations';
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
import { JobCardDocument } from '@/components/jobs/JobCardDocument';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';
import { useOperation } from '@/hooks/useOperation';
import { useQuery } from '@/hooks/useQuery';
import { useApp } from '@/providers/AppProvider';

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
  const alreadyClosed = job.status === 'closed' || job.status === 'submitted';

  return (
    <>
      <PageHeader
        title="Review job card"
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

      {!alreadyClosed && submitted === null && (
        <Card className="mb-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardHeader
                title="Ready to submit"
                description={`The signed job card will be emailed to ${customerDisplayName} at ${customerEmail}.`}
              />
            </div>
            <Button
              size="lg"
              onClick={() => setConfirmOpen(true)}
              leadingIcon={<Icon name="mail" className="size-5" />}
            >
              Submit Job Card
            </Button>
          </div>
        </Card>
      )}

      <div className="eje-scrollbar overflow-x-auto rounded-[var(--radius-card)] bg-steel-200/60 p-4 sm:p-8">
        <JobCardDocument view={view} />
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Submit Job Card?"
        message={
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
        }
        confirmLabel="Submit"
        cancelLabel="Cancel"
        busy={operation.running}
        onConfirm={async () => {
          const ok = await operation.run(async (context) => {
            const result = await submitJob(context, job, customerEmail, customerDisplayName);
            setSubmitted({ fileName: result.documentFileName, to: result.emailedTo });
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
