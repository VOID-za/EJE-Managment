'use client';

import { useMemo, useState } from 'react';
import type { ActivityEventType } from '@/domain';
import { userFullName } from '@/domain';
import {
  Card,
  ErrorState,
  Icon,
  LoadingPanel,
  SelectField,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { ActivityFeed } from '@/components/dashboard/ActivityFeed';
import { useQuery } from '@/hooks/useQuery';

const TYPE_GROUPS: readonly { value: string; label: string; types: readonly ActivityEventType[] }[] =
  [
    { value: 'all', label: 'All activity', types: [] },
    {
      value: 'workflow',
      label: 'Workflow changes',
      types: [
        'job_created',
        'job_accepted',
        'moved_to_awaiting_spares',
        'returned_to_in_progress',
        'completion_started',
        'customer_signed',
        'job_submitted',
        'job_closed',
      ],
    },
    {
      value: 'capture',
      label: 'Work captured',
      types: ['labour_added', 'travel_added', 'part_added', 'photo_uploaded', 'note_added'],
    },
    {
      value: 'assignment',
      label: 'Assignment',
      types: ['job_assigned', 'technician_added', 'technician_removed'],
    },
    {
      value: 'records',
      label: 'Record changes',
      types: ['customer_updated', 'machine_updated', 'document_viewed', 'checklist_completed'],
    },
  ];

const ActivityPage = () => {
  const [group, setGroup] = useState('all');
  const [actor, setActor] = useState('all');

  const query = useQuery('activity:all', async (repos) => {
    const [activity, users, jobs] = await Promise.all([
      repos.activity.list(),
      repos.users.list(),
      repos.jobs.list(),
    ]);
    return {
      activity,
      users,
      jobNumbers: new Map(jobs.map((job) => [job.id as string, job.jobNumber])),
    };
  });

  const events = useMemo(() => {
    const all = query.data?.activity ?? [];
    const selected = TYPE_GROUPS.find((candidate) => candidate.value === group);
    return all
      .filter(
        (event) =>
          selected === undefined ||
          selected.types.length === 0 ||
          selected.types.includes(event.type),
      )
      .filter((event) => actor === 'all' || event.actorId === actor);
  }, [query.data?.activity, group, actor]);

  if (query.error !== null) {
    return <ErrorState message={query.error} onRetry={query.refetch} />;
  }

  return (
    <>
      <PageHeader
        title="Activity"
        breadcrumbs={[{ label: 'Activity' }]}
        description="A complete audit trail: who did what, and when. Every entry is written by the system at the moment the action happened."
      />

      <Card className="mb-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <SelectField
            label="Activity type"
            value={group}
            onChange={(event) => setGroup(event.target.value)}
            options={TYPE_GROUPS.map((candidate) => ({
              value: candidate.value,
              label: candidate.label,
            }))}
          />
          <SelectField
            label="User"
            value={actor}
            onChange={(event) => setActor(event.target.value)}
            options={[
              { value: 'all', label: 'All users' },
              ...(query.data?.users ?? []).map((user) => ({
                value: user.id,
                label: userFullName(user),
              })),
            ]}
          />
          <div className="flex items-end">
            <p className="tabular pb-3 text-sm text-steel-500">
              {events.length} {events.length === 1 ? 'entry' : 'entries'}
            </p>
          </div>
        </div>
      </Card>

      {query.loading ? (
        <LoadingPanel rows={6} label="Loading activity" />
      ) : (
        <Card>
          <ActivityFeed
            events={events}
            users={query.data?.users ?? []}
            jobNumbers={query.data?.jobNumbers}
            emptyMessage="No activity matches the current filters."
          />
        </Card>
      )}

      <p className="mt-4 flex items-center gap-2 px-1 text-xs text-steel-500">
        <Icon name="activity" className="size-3.5" />
        In production this trail is immutable and retained for the life of the job record.
      </p>
    </>
  );
};

export default ActivityPage;
