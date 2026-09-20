'use client';

import { use, useState } from 'react';
import {
  availabilityTimeLabel,
  availabilityTypeLabel,
  can,
  roleLabel,
  summariseAvailability,
  userFullName,
  type AvailabilityRecord,
} from '@/domain';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  DefinitionGrid,
  EmptyState,
  ErrorState,
  Icon,
  LoadingPanel,
  Tabs,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { AvailabilityDialog } from '@/components/availability/AvailabilityDialog';
import { JobListTable } from '@/components/jobs/JobListTable';
import { useOperation } from '@/hooks/useOperation';
import { availability, reads } from '@/api/endpoints';
import { useQuery } from '@/hooks/useQuery';
import { useCurrentUser } from '@/providers/AppProvider';
import { formatDate, formatDateTime } from '@/lib/format';
import { businessToday } from '@/lib/business-time';

/**
 * Technician profile.
 *
 * Exists chiefly for availability: this is where a Master marks someone
 * unavailable and sees what that will collide with. A technician can open their
 * own profile and read their availability, but not change it — official
 * availability is the office's record, which is exactly what makes it safe to
 * block job assignment on.
 */
type TabId = 'availability' | 'jobs' | 'messages';

const TechnicianProfilePage = ({
  params,
}: {
  readonly params: Promise<{ readonly userId: string }>;
}) => {
  const { userId } = use(params);
  const currentUser = useCurrentUser();
  const operation = useOperation();
  const [tab, setTab] = useState<TabId>('availability');
  const [recording, setRecording] = useState(false);
  const [editing, setEditing] = useState<AvailabilityRecord | null>(null);
  const [cancelling, setCancelling] = useState<AvailabilityRecord | null>(null);

  const today = businessToday();
  const canManage = can(currentUser.role, 'admin.access');

  const query = useQuery(`technician:${userId}`, () => reads.technician(userId));

  if (query.error !== null) {
    return <ErrorState message={query.error} onRetry={query.refetch} />;
  }
  if (query.loading) {
    return (
      <>
        <PageHeader title="Loading technician…" />
        <LoadingPanel rows={4} label="Loading technician" />
      </>
    );
  }

  const data = query.data;
  if (data === null || data === undefined) {
    return (
      <EmptyState
        title="User not found"
        description="This user does not exist in the system."
        icon={<Icon name="user" />}
      />
    );
  }

  const { technician, records, jobRows, messages, users } = data;
  // Who put a record on the calendar, by name — "the office" is not an answer
  // when the question is who marked someone unavailable.
  const authorName = (id: string): string => {
    const author = users.find((candidate) => candidate.id === id);
    return author === undefined ? 'a Master' : userFullName(author);
  };
  const active = records.filter((record) => record.status === 'active');
  const current = active.filter(
    (record) => record.startDate <= today && record.endDate >= today,
  );
  const upcoming = active.filter((record) => record.startDate > today);
  const past = active.filter((record) => record.endDate < today);
  const cancelled = records.filter((record) => record.status === 'cancelled');

  const section = (
    title: string,
    description: string,
    list: readonly AvailabilityRecord[],
  ) => (
    <Card key={title}>
      <CardHeader title={title} description={description} />
      {list.length === 0 ? (
        <p className="mt-3 text-sm text-steel-500 italic">Nothing recorded.</p>
      ) : (
        <ul className="mt-3 divide-y divide-steel-100">
          {list.map((record) => (
            <li key={record.id} className="flex flex-wrap items-start gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-steel-900">
                  {availabilityTypeLabel(record.type)}
                  <Badge tone={record.allDay ? 'neutral' : 'amber'} size="sm">
                    {availabilityTimeLabel(record)}
                  </Badge>
                  {record.status === 'cancelled' && (
                    <Badge tone="neutral" size="sm">
                      Cancelled
                    </Badge>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-steel-500">
                  {formatDate(record.startDate)}
                  {record.endDate !== record.startDate && ` – ${formatDate(record.endDate)}`}
                </p>
                {record.description.length > 0 && (
                  <p className="mt-1 text-sm text-steel-600">{record.description}</p>
                )}
                <p className="mt-1 text-[11px] text-steel-400">
                  Recorded by {authorName(record.createdBy)} ·{' '}
                  {formatDateTime(record.createdAt)}
                  {record.cancelledBy !== null &&
                    ` · cancelled by ${authorName(record.cancelledBy)}`}
                </p>
              </div>
              {canManage && record.status === 'active' && (
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(record)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setCancelling(record)}>
                    Cancel
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );

  return (
    <>
      <PageHeader
        title={userFullName(technician)}
        breadcrumbs={[
          { label: 'Administration', href: '/admin' },
          { label: userFullName(technician) },
        ]}
        description={`${technician.jobTitle} · ${roleLabel(technician.role)}`}
        actions={
          canManage && technician.role !== 'master' ? (
            <Button
              leadingIcon={<Icon name="clock" className="size-4" />}
              onClick={() => setRecording(true)}
            >
              Mark unavailable
            </Button>
          ) : undefined
        }
      />

      {operation.error !== null && (
        <p role="alert" className="mb-4 text-sm font-medium text-signal-600">
          {operation.error}
        </p>
      )}

      <Card className="mb-5">
        <div className="flex flex-wrap items-center gap-4">
          <Avatar initials={technician.initials} size="lg" />
          <DefinitionGrid
            className="flex-1"
            columns={3}
            items={[
              { label: 'Email', value: technician.email },
              { label: 'Mobile', value: technician.mobile },
              {
                label: 'Status',
                value: (
                  <Badge tone={technician.active ? 'green' : 'neutral'} size="sm" dot>
                    {technician.active ? 'Active' : 'Disabled'}
                  </Badge>
                ),
              },
              {
                label: 'Available today',
                value:
                  current.length === 0 ? (
                    <Badge tone="green" size="sm" dot>
                      Available
                    </Badge>
                  ) : (
                    <Badge tone="amber" size="sm" dot>
                      {summariseAvailability(current[0]!)}
                    </Badge>
                  ),
              },
              { label: 'On record since', value: formatDate(technician.createdAt) },
            ]}
          />
        </div>
      </Card>

      <Tabs
        tabs={[
          { id: 'availability', label: `Availability (${active.length})` },
          { id: 'jobs', label: `Jobs (${jobRows.length})` },
          { id: 'messages', label: `Messages (${messages.length})` },
        ]}
        activeId={tab}
        onChange={(id) => setTab(id as TabId)}
        className="mb-5"
      />

      {tab === 'availability' && (
        <div className="space-y-4">
          {!canManage && (
            <div className="rounded-[var(--radius-control)] border border-eje-200 bg-eje-50 px-4 py-3 text-sm text-eje-800">
              This is the official record the office keeps. If something needs to change, send the
              office a message — a Master records it here.
            </div>
          )}
          {section('Current', 'In effect today.', current)}
          {section('Upcoming', 'Booked for later.', upcoming)}
          {section('Past', 'Already served.', past)}
          {cancelled.length > 0 &&
            section('Cancelled', 'Kept on file. No longer blocking work.', cancelled)}
        </div>
      )}

      {tab === 'jobs' && (
        <JobListTable
          rows={[...jobRows].sort((a, b) => b.job.createdAt.localeCompare(a.job.createdAt))}
          emptyTitle="No jobs"
          emptyDescription="This technician has no jobs on record."
        />
      )}

      {tab === 'messages' && (
        <Card>
          <CardHeader
            title="Messages to the office"
            description="What this technician has told the office, and what was recorded as a result."
          />
          {messages.length === 0 ? (
            <p className="mt-3 text-sm text-steel-500 italic">No messages.</p>
          ) : (
            <ul className="mt-3 divide-y divide-steel-100">
              {messages.map((message) => {
                const linked = records.find(
                  (record) => record.id === message.availabilityRecordId,
                );
                return (
                  <li key={message.id} className="py-3">
                    <p className="text-sm text-steel-800">{message.body}</p>
                    <p className="mt-1 text-xs text-steel-400">
                      {formatDateTime(message.sentAt)}
                    </p>
                    {linked === undefined ? (
                      <Badge tone="neutral" size="sm" className="mt-2">
                        No availability recorded
                      </Badge>
                    ) : (
                      <p className="mt-2 text-xs text-verdant-700">
                        <Icon name="check" className="mr-1 inline size-3" />
                        Availability recorded — {summariseAvailability(linked)}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}

      {recording && (
        <AvailabilityDialog
          technician={technician}
          onClose={() => setRecording(false)}
          onSaved={() => {
            setRecording(false);
            query.refetch();
          }}
        />
      )}

      {editing !== null && (
        <AvailabilityDialog
          technician={technician}
          existing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            query.refetch();
          }}
        />
      )}

      <ConfirmDialog
        open={cancelling !== null}
        title="Cancel this availability?"
        message={
          cancelling === null
            ? ''
            : `${summariseAvailability(cancelling)} will stop blocking work. The record is kept on file, not deleted.`
        }
        confirmLabel="Cancel availability"
        busy={operation.running}
        onConfirm={async () => {
          if (cancelling === null) return;
          const ok = await operation.run(() => availability.cancel(cancelling.id));
          setCancelling(null);
          if (ok) query.refetch();
        }}
        onCancel={() => setCancelling(null)}
      />
    </>
  );
};


export default TechnicianProfilePage;
