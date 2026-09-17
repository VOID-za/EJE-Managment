'use client';

import { use, useState } from 'react';
import {
  getJobTypeDefinition,
  isJobEditable,
  isJobWorkable,
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
import { JobActionBar } from '@/components/jobs/JobActionBar';
import { JobMediaPanel } from '@/components/jobs/JobMediaPanel';
import { JobNotesPanel } from '@/components/jobs/JobNotesPanel';
import { JobOverviewPanel } from '@/components/jobs/JobOverviewPanel';
import { JobProgressRail } from '@/components/jobs/JobProgressRail';
import { JobTypeChip } from '@/components/jobs/JobTypeChip';
import { WorkCapturePanel } from '@/components/jobs/WorkCapturePanel';
import { useQuery } from '@/hooks/useQuery';
import { formatDate } from '@/lib/format';

type TabId = 'overview' | 'work' | 'completion' | 'checklist' | 'media' | 'notes' | 'activity';

const JobDetailPage = ({
  params,
}: {
  readonly params: Promise<{ readonly jobNumber: string }>;
}) => {
  const { jobNumber } = use(params);
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

  const editable = isJobEditable(job.status);
  const workable = isJobWorkable(job.status) && editable;
  const definition = getJobTypeDefinition(job.jobType);
  const refresh = () => viewQuery.refetch();

  const tabs = [
    { id: 'overview', label: 'Overview' },
    {
      id: 'work',
      label: 'Labour & Parts',
      badge:
        job.labour.length + job.travel.length + job.parts.length > 0 ? (
          <Badge tone="neutral" size="sm">
            {job.labour.length + job.travel.length + job.parts.length}
          </Badge>
        ) : undefined,
    },
    { id: 'completion', label: 'Completion' },
    ...(definition.checklistRequired
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
        description={`${view.customer.name} · ${view.site.name} · ${view.machine.manufacturer} ${view.machine.model}`}
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
                Read-only — this job has been submitted
              </Badge>
            )}
          </div>
        }
      />

      <Card className="mb-5">
        <JobProgressRail status={job.status} />
        <div className="mt-4 border-t border-steel-100 pt-4">
          <JobActionBar job={job} onChanged={refresh} />
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

      {tab === 'checklist' && view.checklistTemplate !== null && (
        <ChecklistRunner
          job={job}
          template={view.checklistTemplate}
          editable={editable}
          onChanged={refresh}
        />
      )}

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
