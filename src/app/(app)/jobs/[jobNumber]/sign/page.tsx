'use client';

import { useRouter } from 'next/navigation';
import { use, useState } from 'react';
import { buildPartsDocument, checkReadyForSignature, signatoryLabelsFor } from '@/domain';
import { captureSignature } from '@/application/job-operations';
import { loadJobView } from '@/application/job-view';
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  Icon,
  LoadingPanel,
  TextField,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { JobCostSummary } from '@/components/jobs/JobCostSummary';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';
import { SignaturePad } from '@/components/jobs/SignaturePad';
import { useOperation } from '@/hooks/useOperation';
import { useQuery } from '@/hooks/useQuery';
import { useCurrentUser } from '@/providers/AppProvider';

/**
 * Signature capture.
 *
 * Deliberately a full screen of its own: the tablet is handed over, so nothing
 * else on the page should be tappable by accident. Who signs and what they are
 * acknowledging comes from `signatoryLabelsFor` — a parts collection is signed
 * for by the collector, acknowledging receipt rather than completed work.
 */
const SignJobPage = ({
  params,
}: {
  readonly params: Promise<{ readonly jobNumber: string }>;
}) => {
  const { jobNumber } = use(params);
  const router = useRouter();
  const operation = useOperation();
  const currentUser = useCurrentUser();

  const [firstName, setFirstName] = useState('');
  const [surname, setSurname] = useState('');
  const [strokeData, setStrokeData] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const viewQuery = useQuery(`job:${jobNumber}:sign`, (repos) =>
    loadJobView(repos, jobNumber, currentUser),
  );

  if (viewQuery.error !== null) {
    return <ErrorState message={viewQuery.error} onRetry={viewQuery.refetch} />;
  }
  if (viewQuery.loading) return <LoadingPanel rows={3} label="Loading job" />;

  const view = viewQuery.data;
  if (view === null || view === undefined) {
    return (
      <EmptyState
        title="Job not found"
        description={`No job with the number ${jobNumber} exists.`}
        icon={<Icon name="jobs" />}
      />
    );
  }

  const { job } = view;
  const readiness = checkReadyForSignature(job);
  const alreadySigned = job.signature !== null;
  // A parts collection is signed for by whoever collects, acknowledging receipt
  // rather than completed work, so the wording comes from the job type.
  const labels = signatoryLabelsFor(job.jobType);
  const collectionDocument = buildPartsDocument(job);

  const submit = async () => {
    const next: Record<string, string> = {};
    if (firstName.trim().length === 0) next.firstName = `The ${labels.nameLabel.toLowerCase()} is required.`;
    if (surname.trim().length === 0) next.surname = `The ${labels.surnameLabel.toLowerCase()} is required.`;
    if (strokeData.length === 0) next.signature = 'A signature is required.';
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    const ok = await operation.run((context) =>
      captureSignature(context, job, {
        customerName: firstName.trim(),
        customerSurname: surname.trim(),
        strokeData,
      }),
    );
    if (ok) router.push(`/jobs/${job.jobNumber}/review`);
  };

  return (
    <>
      <PageHeader
        title={labels.pageTitle}
        breadcrumbs={[
          { label: 'Jobs', href: '/jobs' },
          { label: job.jobNumber, href: `/jobs/${job.jobNumber}` },
          { label: labels.pageTitle },
        ]}
        description={[view.customer.name, view.site.name, view.machine === null ? null : `${view.machine.manufacturer} ${view.machine.model}`].filter((part) => part !== null).join(' · ')}
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

      {alreadySigned ? (
        <Card>
          <CardHeader
            title={
              job.jobType === 'parts'
                ? 'These parts have already been signed for'
                : 'This job card has already been signed'
            }
            description={`Signed by ${job.signature?.customerName} ${job.signature?.customerSurname}.`}
          />
          <Button className="mt-4" onClick={() => router.push(`/jobs/${job.jobNumber}/review`)}>
            Review job card
          </Button>
        </Card>
      ) : !readiness.allowed ? (
        <RuleViolationNotice
          title="This job is not ready for signature"
          violations={readiness.violations}
          message="Complete the outstanding items on the job before handing the tablet to the customer."
        />
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <Card>
              <CardHeader
                title={labels.sectionTitle}
                description={labels.sectionDescription}
              />

              <div className="mt-5 rounded-[var(--radius-card)] border-2 border-steel-900 bg-steel-50 p-5">
                <p className="text-base leading-relaxed font-semibold text-steel-900">
                  {labels.declaration}
                </p>
                <p className="mt-2 text-sm text-steel-600">
                  Job {job.jobNumber} — {view.customer.name}, {view.site.name}
                </p>
              </div>

              <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <TextField
                  label={labels.nameLabel}
                  required
                  value={firstName}
                  onChange={(event) => setFirstName(event.target.value)}
                  error={errors.firstName}
                  autoComplete="off"
                  className="h-13 text-base"
                />
                <TextField
                  label={labels.surnameLabel}
                  required
                  value={surname}
                  onChange={(event) => setSurname(event.target.value)}
                  error={errors.surname}
                  autoComplete="off"
                  className="h-13 text-base"
                />
              </div>

              <div className="mt-5">
                <p className="mb-1.5 text-sm font-semibold text-steel-700">
                  {labels.signatureLabel}
                  <span className="ml-1 text-signal-600">*</span>
                </p>
                <SignaturePad onChange={setStrokeData} />
                {errors.signature !== undefined && (
                  <p className="mt-1 text-xs font-medium text-signal-600">{errors.signature}</p>
                )}
              </div>

              {operation.error !== null && (
                <div className="mt-4">
                  <RuleViolationNotice
                    title="The signature could not be captured"
                    message={operation.error}
                    violations={operation.violations}
                  />
                </div>
              )}

              <div className="mt-6 flex flex-wrap justify-end gap-2 border-t border-steel-100 pt-5">
                <Button
                  variant="secondary"
                  size="lg"
                  onClick={() => router.push(`/jobs/${job.jobNumber}`)}
                >
                  Cancel
                </Button>
                <Button size="lg" onClick={submit} loading={operation.running}>
                  {labels.confirmLabel}
                </Button>
              </div>
            </Card>
          </div>

          <div className="space-y-5">
            {job.jobType === 'parts' ? (
              <Card>
                <CardHeader
                  title="Parts being collected"
                  description="What the collector is signing for."
                />
                <ul className="mt-3 divide-y divide-steel-100">
                  {collectionDocument.lines.map((line, index) => (
                    <li
                      key={`${line.partNumber}-${index}`}
                      className="flex items-baseline justify-between gap-3 py-2"
                    >
                      <span className="min-w-0">
                        <span className="block font-mono text-sm font-medium text-steel-900">
                          {line.partNumber}
                        </span>
                        <span className="block text-sm text-steel-600">{line.description}</span>
                      </span>
                      <span className="tabular shrink-0 text-sm font-semibold text-steel-900">
                        &times;&nbsp;{line.quantity}
                      </span>
                    </li>
                  ))}
                </ul>
                {!collectionDocument.showsPrices && (
                  <p className="mt-3 text-xs text-steel-500">
                    This is a courier collection, so prices are withheld from the collection note.
                    They remain on the job for EJE costing.
                  </p>
                )}
              </Card>
            ) : (
            <Card>
              <CardHeader title="Work performed" description="What the customer is signing for." />
              <p className="mt-3 text-sm leading-relaxed whitespace-pre-line text-steel-700">
                {job.completionReport.workPerformed}
              </p>
              {job.completionReport.recommendations.trim().length > 0 && (
                <>
                  <p className="mt-4 text-xs font-semibold tracking-wide text-steel-500 uppercase">
                    Recommendations
                  </p>
                  <p className="mt-1 text-sm leading-relaxed whitespace-pre-line text-steel-700">
                    {job.completionReport.recommendations}
                  </p>
                </>
              )}
            </Card>
            )}

            {(job.jobType !== 'parts' || collectionDocument.showsPrices) && (
              <Card>
                <CardHeader title="Job value" />
                <JobCostSummary job={job} settings={view.settings} className="mt-4" />
              </Card>
            )}
          </div>
        </div>
      )}
    </>
  );
};

export default SignJobPage;
