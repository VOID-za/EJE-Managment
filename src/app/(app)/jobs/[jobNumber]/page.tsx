'use client';

import { use, useState } from 'react';
import {
  getJobTypeDefinition,
  canEditJob,
  cancellationReasonLabel,
  isJobWorkable,
  userFullName,
  type ActivityEvent,
  type User,
} from '@/domain';
import { loadJobView } from '@/application/job-view';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Icon,
  JobStatusBadge,
  LoadingPanel,
  PriorityBadge,
  Tabs,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { ActivityFeed } from '@/components/dashboard/ActivityFeed';
import { ChecklistRunner } from '@/components/jobs/ChecklistRunner';
import { CompletionReportPanel } from '@/components/jobs/CompletionReportPanel';
import { FinalDocumentCard } from '@/components/jobs/FinalDocumentCard';
import { JobActionBar } from '@/components/jobs/JobActionBar';
import { JobMediaPanel } from '@/components/jobs/JobMediaPanel';
import { JobNotesPanel } from '@/components/jobs/JobNotesPanel';
import { JobOverviewPanel } from '@/components/jobs/JobOverviewPanel';
import { JobProgressRail } from '@/components/jobs/JobProgressRail';
import { JobTypeChip } from '@/components/jobs/JobTypeChip';
import { WorkCapturePanel } from '@/components/jobs/WorkCapturePanel';
import { useQuery } from '@/hooks/useQuery';
import { useCurrentUser } from '@/providers/AppProvider';
import { formatDate, formatDateTime } from '@/lib/format';

type TabId = 'overview' | 'work' | 'completion' | 'checklist' | 'media' | 'notes' | 'activity';

/** Names the person behind an id, so a banner never reads "cancelled by null". */
const userName = (users: readonly User[], id: string | null): string => {
  if (id === null) return 'the office';
  const user = users.find((candidate) => candidate.id === id);
  return user === undefined ? 'the office' : userFullName(user);
};

const JobDetailPage = ({
  params,
}: {
  readonly params: Promise<{ readonly jobNumber: string }>;
}) => {
  const { jobNumber } = use(params);
  const currentUser = useCurrentUser();
  const [tab, setTab] = useState<TabId>('overview');

  const viewQuery = useQuery(`job:${jobNumber}`, (repos) => loadJobView(repos, jobNumber));
  const supportQuery = useQuery(`job:${jobNumber}:support`, async (repos) => {
    const [users, activity] = await Promise.all([repos.users.list(), repos.activity.list()]);
    return { users, activity };
  });

  if (viewQuery.error !== null) {
    return <ErrorState message={viewQuery.error} onRetry={viewQuery.refetch} />;
  }
  if (viewQuery.loading) {
    return (
      <>
        <PageHeader title="Loading job…" />
        <LoadingPanel rows={5} label="Loading job" />
      </>
    );
  }

  const view = viewQuery.data;
  if (view === null || view === undefined) {
    return (
      <EmptyState
        title="Job not found"
        description={`No job with the number ${jobNumber} exists in the system.`}
        icon={<Icon name="jobs" />}
      />
    );
  }

  const { job } = view;
  const users: readonly User[] = supportQuery.data?.users ?? [];
  const activity: readonly ActivityEvent[] = (supportQuery.data?.activity ?? []).filter(
    (event) => event.jobId === job.id,
  );

  const editable = canEditJob(currentUser.role, job.status);
  const workable = isJobWorkable(currentUser.role, job.status);
  const definition = getJobTypeDefinition(job.jobType);
  const refresh = () => viewQuery.refetch();

  const checklistTabVisible = definition.checklistRequired || job.checklist !== null;

  const tabs = [
    { id: 'overview', label: 'Overview' },
    {
      id: 'work',
      label: definition.capturesLabourAndTravel ? 'Labour & Parts' : 'Parts',
      badge:
        job.labour.length + job.travel.length + job.parts.length > 0 ? (
          <Badge tone="neutral" size="sm">
            {job.labour.length + job.travel.length + job.parts.length}
          </Badge>
        ) : undefined,
    },
    { id: 'completion', label: 'Completion' },
    ...(checklistTabVisible
      ? [
          {
            id: 'checklist',
            label: 'Checklist',
            badge:
              job.checklist?.completedAt !== null && job.checklist !== null ? (
                <Badge tone="green" size="sm">
                  Done
                </Badge>
              ) : (
                <Badge tone="amber" size="sm">
                  Required
                </Badge>
              ),
          },
        ]
      : []),
    {
      id: 'media',
      label: 'Photos',
      badge:
        job.photos.length + job.videos.length > 0 ? (
          <Badge tone="neutral" size="sm">
            {job.photos.length + job.videos.length}
          </Badge>
        ) : undefined,
    },
    {
      id: 'notes',
      label: 'Notes',
      badge:
        job.notes.length > 0 ? (
          <Badge tone="neutral" size="sm">
            {job.notes.length}
          </Badge>
        ) : undefined,
    },
    { id: 'activity', label: 'Activity' },
  ];

  return (
    <>
      <PageHeader
        title={job.jobNumber}
        breadcrumbs={[{ label: 'Jobs', href: '/jobs' }, { label: job.jobNumber }]}
        description={[view.customer.name, view.site.name, view.machine === null ? null : `${view.machine.manufacturer} ${view.machine.model}`].filter((part) => part !== null).join(' · ')}
        meta={
          <div className="flex flex-wrap items-center gap-2">
            <JobStatusBadge status={job.status} />
            <JobTypeChip jobType={job.jobType} />
            <PriorityBadge priority={job.priority} />
            {job.scheduledDate !== null && (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-steel-500">
                <Icon name="calendar" className="size-3.5" />
                {formatDate(job.scheduledDate)}
              </span>
            )}
            {!editable && (
              <Badge tone="neutral" size="sm">
                {job.status === 'closed'
                  ? 'Read-only — this job is closed'
                  : job.status === 'cancelled'
                    ? 'Read-only — this job was cancelled'
                    : job.status === 'awaiting_delivery'
                      ? 'Read-only — the job card has been issued'
                      : 'Read-only — awaiting Master review'}
              </Badge>
            )}
          </div>
        }
      />

      {/* A job that has left the workflow must never look like live work, so
          this states what happened, why, and who did it — before anything else
          on the page. */}
      {job.deletedAt !== null && (
        <Card className="mb-5 border-signal-300 bg-signal-50">
          <p className="text-sm font-bold tracking-wide text-signal-700 uppercase">Deleted</p>
          <p className="mt-1 text-sm text-signal-800">{job.deletionReason}</p>
          <p className="mt-1 text-xs text-signal-700">
            Deleted by {userName(users, job.deletedBy)} on {formatDateTime(job.deletedAt)}. The
            record and its history are retained.
          </p>
        </Card>
      )}

      {/* A closed job's first business is its official job card, so the
          document and its actions come before the record itself. */}
      {job.status === 'closed' && job.deletedAt === null && (
        <FinalDocumentCard job={job} users={users} />
      )}

      {job.status === 'cancelled' && job.cancellation !== null && (
        <Card className="mb-5 border-signal-300 bg-signal-50">
          <p className="text-sm font-bold tracking-wide text-signal-700 uppercase">Cancelled</p>
          <p className="mt-1 text-sm font-semibold text-signal-800">
            {cancellationReasonLabel(job.cancellation.reason)}
          </p>
          {job.cancellation.description.length > 0 && (
            <p className="mt-1 text-sm text-signal-800">{job.cancellation.description}</p>
          )}
          <p className="mt-1 text-xs text-signal-700">
            Cancelled by {userName(users, job.cancellation.cancelledBy)} on{' '}
            {formatDateTime(job.cancellation.cancelledAt)}.
          </p>
        </Card>
      )}

      <Card className="mb-5">
        <JobProgressRail status={job.status} />
        <div className="mt-4 border-t border-steel-100 pt-4">
          <JobActionBar view={view} onChanged={refresh} />
        </div>
      </Card>

      <Tabs
        tabs={tabs}
        activeId={tab}
        onChange={(id) => setTab(id as TabId)}
        className="mb-5"
      />

      {tab === 'overview' && (
        <JobOverviewPanel view={view} users={users} editable={editable} onChanged={refresh} />
      )}

      {tab === 'work' && (
        <WorkCapturePanel
          job={job}
          settings={view.settings}
          users={users}
          editable={workable}
          onChanged={refresh}
        />
      )}

      {tab === 'completion' && (
        <CompletionReportPanel job={job} editable={editable} onChanged={refresh} />
      )}

      {tab === 'checklist' &&
        (view.checklistVersionMissing ? (
          <ErrorState
            title="Checklist version unavailable"
            message={`This job was completed against checklist version ${job.checklist?.templateVersion ?? 'unknown'}, which is no longer held. The answers are preserved on the job, but the wording cannot be shown. It is deliberately not rendered against the current version.`}
          />
        ) : view.checklistTemplate !== null ? (
          <ChecklistRunner
            job={job}
            template={view.checklistTemplate}
            editable={editable}
            onChanged={refresh}
          />
        ) : null)}

      {tab === 'media' && (
        <JobMediaPanel job={job} users={users} editable={editable} onChanged={refresh} />
      )}

      {tab === 'notes' && (
        <JobNotesPanel job={job} users={users} editable={editable} onChanged={refresh} />
      )}

      {tab === 'activity' && (
        <Card>
          <ActivityFeed
            events={activity}
            users={users}
            emptyMessage="Actions taken against this job will be recorded here."
          />
        </Card>
      )}
    </>
  );
};

export default JobDetailPage;
