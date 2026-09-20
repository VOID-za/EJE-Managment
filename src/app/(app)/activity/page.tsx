'use client';

import { useMemo, useState } from 'react';
import type { ActivityEventType } from '@/domain';
import { canReadActivityFeed, userFullName } from '@/domain';
import {
  Card,
  EmptyState,
  ErrorState,
  Icon,
  LoadingPanel,
  SelectField,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { ActivityFeed } from '@/components/dashboard/ActivityFeed';
import { reads } from '@/api/endpoints';
import { useQuery } from '@/hooks/useQuery';
import { useCurrentUser } from '@/providers/AppProvider';

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
  const currentUser = useCurrentUser();
  const [group, setGroup] = useState('all');
  const [actor, setActor] = useState('all');

  /*
   * Read through the application layer, which decides what comes back.
   *
   * `loadActivityFeed` refuses a role without `activity.viewAll` and filters
   * per event for whoever passes. The check below is a courtesy — a sentence
   * instead of an error panel — and never the thing that protects the trail:
   * typing the URL, or calling the read some other way, hits the same refusal.
   */
  const permitted = canReadActivityFeed(currentUser.role);

  const query = useQuery(`activity:all:${currentUser.id}`, async () =>
    canReadActivityFeed(currentUser.role) ? reads.activity() : null,
  );

  // A Map does not survive JSON, so the API sends pairs and it is rebuilt here.
  const jobNumbers = useMemo(
    () => new Map(query.data?.jobNumbers ?? []),
    [query.data?.jobNumbers],
  );

  const events = useMemo(() => {
    const all = query.data?.events ?? [];
    const selected = TYPE_GROUPS.find((candidate) => candidate.value === group);
    return all
      .filter(
        (event) =>
          selected === undefined ||
          selected.types.length === 0 ||
          selected.types.includes(event.type),
      )
      .filter((event) => actor === 'all' || event.actorId === actor);
  }, [query.data?.events, group, actor]);

  if (!permitted) {
    return (
      <>
        <PageHeader title="Activity" breadcrumbs={[{ label: 'Activity' }]} />
        <EmptyState
          title="The activity trail is an office record"
          description="It carries every change made across the business, including other people's jobs and EJE's commercial settings. The history of a job you worked is on the job itself, under Activity."
          icon={<Icon name="activity" />}
        />
      </>
    );
  }

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
            jobNumbers={jobNumbers}
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
