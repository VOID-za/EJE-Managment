'use client';

import Link from 'next/link';
import { availabilityTypeLabel } from '@/domain';
import {
  Badge,
  Button,
  DefinitionGrid,
  Modal,
  PriorityBadge,
  JobStatusBadge,
} from '@/components/ui';
import { JobTypeChip } from '@/components/jobs/JobTypeChip';
import { formatDate } from '@/lib/format';
import type { CalendarEntry } from '@/application/calendar';

/**
 * Progressive disclosure for a calendar entry.
 *
 * The month grid deliberately shows almost nothing, so this is where the rest
 * lives. A job bar links straight to its job card, which already carries every
 * field; an ABSENCE has no page of its own, so this is its detail view — and it
 * links on to the technician, where the office edits or cancels the period.
 *
 * Built from the same `DefinitionGrid`, `JobStatusBadge`, `PriorityBadge` and
 * `JobTypeChip` used on the job screens, so nothing here is a second rendering
 * of the same facts.
 */
export const CalendarEntryDetail = ({
  entry,
  onClose,
}: {
  readonly entry: CalendarEntry;
  readonly onClose: () => void;
}) => {
  const dateRange =
    entry.start === entry.end
      ? formatDate(entry.start)
      : `${formatDate(entry.start)} – ${formatDate(entry.end)} (${entry.days} days)`;

  if (entry.kind === 'job') {
    return (
      <Modal
        open
        title={entry.jobNumber}
        description={entry.customerName}
        onClose={onClose}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
            <Link href={`/jobs/${entry.jobNumber}`}>
              <Button>Open job card</Button>
            </Link>
          </>
        }
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <JobTypeChip jobType={entry.jobType} />
            <JobStatusBadge status={entry.status} />
            <PriorityBadge priority={entry.priority} />
          </div>

          <DefinitionGrid
            columns={2}
            items={[
              { label: 'Customer', value: entry.customerName, wide: true },
              { label: 'Site', value: entry.siteName.length > 0 ? entry.siteName : '—' },
              { label: 'Machine', value: entry.machineLabel },
              { label: 'Scheduled', value: dateRange, wide: true },
              {
                label: entry.technicianNames.length > 1 ? 'Technicians' : 'Technician',
                value:
                  entry.technicianNames.length === 0
                    ? 'Unassigned'
                    : entry.technicianNames.join(', '),
                wide: true,
              },
            ]}
          />
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      title={entry.userName}
      description={`${availabilityTypeLabel(entry.availabilityType)} · ${entry.timeLabel}`}
      onClose={onClose}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Link href={`/technicians/${entry.userId}`}>
            <Button>Open technician</Button>
          </Link>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={entry.availabilityStatus === 'cancelled' ? 'neutral' : 'amber'} size="sm" dot>
            {entry.availabilityStatus === 'cancelled' ? 'Cancelled' : 'Unavailable'}
          </Badge>
          <Badge tone="outline" size="sm">
            {entry.allDay ? 'All day' : entry.timeLabel}
          </Badge>
        </div>

        <DefinitionGrid
          columns={2}
          items={[
            { label: 'Technician', value: entry.userName, wide: true },
            { label: 'Type', value: availabilityTypeLabel(entry.availabilityType) },
            { label: 'Time', value: entry.timeLabel },
            { label: 'Dates', value: dateRange, wide: true },
            {
              label: 'Description',
              value: entry.description.length > 0 ? entry.description : '—',
              wide: true,
            },
          ]}
        />

        {entry.availabilityStatus === 'cancelled' ? (
          <p className="text-xs text-steel-500">
            This period was cancelled and no longer blocks work. It is kept on file.
          </p>
        ) : (
          <p className="text-xs text-steel-500">
            While this period stands, {entry.userName.split(' ')[0]} cannot be assigned to a job
            scheduled on these days.
          </p>
        )}
      </div>
    </Modal>
  );
};
