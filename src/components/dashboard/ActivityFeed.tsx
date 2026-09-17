import Link from 'next/link';
import type { ActivityEvent, User } from '@/domain';
import { userFullName } from '@/domain';
import { Avatar, EmptyState, Icon, type IconName } from '@/components/ui';
import { formatRelative } from '@/lib/format';

const ICONS: Partial<Record<ActivityEvent['type'], IconName>> = {
  job_created: 'plus',
  job_assigned: 'user',
  job_accepted: 'check',
  technician_added: 'user',
  technician_removed: 'user',
  note_added: 'note',
  photo_uploaded: 'camera',
  labour_added: 'clock',
  travel_added: 'truck',
  part_added: 'box',
  checklist_completed: 'check',
  moved_to_awaiting_spares: 'warning',
  returned_to_in_progress: 'refresh',
  completion_started: 'wrench',
  customer_signed: 'signature',
  pdf_generated: 'document',
  job_submitted: 'mail',
  job_closed: 'check',
  document_viewed: 'library',
  customer_updated: 'customers',
  machine_updated: 'machines',
};

export interface ActivityFeedProps {
  readonly events: readonly ActivityEvent[];
  readonly users: readonly User[];
  /** Job numbers by job id, so entries can link through to the job. */
  readonly jobNumbers?: ReadonlyMap<string, string>;
  readonly emptyMessage?: string;
}

export const ActivityFeed = ({
  events,
  users,
  jobNumbers,
  emptyMessage,
}: ActivityFeedProps) => {
  if (events.length === 0) {
    return (
      <EmptyState
        title="No activity yet"
        description={emptyMessage ?? 'Actions taken in the system will appear here.'}
      />
    );
  }

  return (
    <ol className="relative space-y-1">
      {events.map((event, index) => {
        const actor = users.find((user) => user.id === event.actorId);
        const jobNumber = event.jobId === null ? null : (jobNumbers?.get(event.jobId) ?? null);

        return (
          <li key={event.id} className="relative flex gap-3 pb-1">
            <div className="flex flex-col items-center">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-steel-100 text-steel-500 ring-1 ring-steel-200">
                <Icon name={ICONS[event.type] ?? 'activity'} className="size-4" />
              </span>
              {index < events.length - 1 && (
                <span className="mt-1 w-px flex-1 bg-steel-200" aria-hidden="true" />
              )}
            </div>

            <div className="min-w-0 flex-1 pb-4">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <p className="text-sm font-semibold text-steel-900">{event.summary}</p>
                {jobNumber !== null && (
                  <Link
                    href={`/jobs/${jobNumber}`}
                    className="font-mono text-xs font-semibold text-eje-600 hover:underline"
                  >
                    {jobNumber}
                  </Link>
                )}
              </div>
              {event.detail.length > 0 && (
                <p className="mt-0.5 text-sm leading-relaxed text-steel-600">{event.detail}</p>
              )}
              <div className="mt-1.5 flex items-center gap-2 text-xs text-steel-400">
                {actor !== undefined && (
                  <>
                    <Avatar initials={actor.initials} size="sm" />
                    <span>{userFullName(actor)}</span>
                    <span aria-hidden="true">·</span>
                  </>
                )}
                <time dateTime={event.occurredAt}>{formatRelative(event.occurredAt)}</time>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
};
