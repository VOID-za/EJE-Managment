'use client';

import { availabilityTypeLabel } from '@/domain';
import { Badge, Button, Icon, Modal } from '@/components/ui';
import { JobTypeChip } from '@/components/jobs/JobTypeChip';
import { formatDate } from '@/lib/format';
import type { CalendarEntry } from '@/application/calendar';
import { entryClasses } from './CalendarEntryChip';

/**
 * Everything booked on one day.
 *
 * Opened by the "+N more" affordance, which exists so a busy day can stay the
 * same height as a quiet one instead of stretching the grid. Nothing is lost by
 * capping the month cell — it is all here, jobs first, then absence.
 */
export const DayEntriesDialog = ({
  date,
  entries,
  onSelect,
  onOpenDay,
  onClose,
}: {
  readonly date: string;
  readonly entries: readonly CalendarEntry[];
  readonly onSelect: (entry: CalendarEntry) => void;
  readonly onOpenDay: () => void;
  readonly onClose: () => void;
}) => {
  const jobs = entries.filter((entry) => entry.kind === 'job');
  const absences = entries.filter((entry) => entry.kind === 'availability');

  return (
    <Modal
      open
      title={formatDate(date)}
      description={`${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'} · ${absences.length} unavailable`}
      onClose={onClose}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button onClick={onOpenDay}>Open day view</Button>
        </>
      }
    >
      <ul className="space-y-1.5">
        {entries.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              onClick={() => onSelect(entry)}
              className="flex w-full items-center gap-2.5 rounded-[var(--radius-control)] border border-steel-200 px-3 py-2.5 text-left transition-colors hover:border-steel-300 hover:bg-steel-50"
            >
              {/* The same tone the bar uses, so the list reads as the cell. */}
              <span
                className={`flex size-6 shrink-0 items-center justify-center rounded ring-1 ring-inset ${entryClasses(entry)}`}
                aria-hidden="true"
              >
                <Icon name={entry.kind === 'job' ? 'jobs' : 'user'} className="size-3" />
              </span>

              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-steel-900">
                  {entry.kind === 'job' ? entry.jobNumber : entry.userName}
                </span>
                <span className="block truncate text-xs text-steel-500">
                  {entry.kind === 'job'
                    ? `${entry.customerName}${entry.siteName.length > 0 ? ` · ${entry.siteName}` : ''}`
                    : `${availabilityTypeLabel(entry.availabilityType)} · ${entry.timeLabel}`}
                </span>
              </span>

              {entry.kind === 'job' ? (
                <JobTypeChip jobType={entry.jobType} />
              ) : (
                <Badge tone="neutral" size="sm">
                  Unavailable
                </Badge>
              )}
              <Icon name="chevronRight" className="size-4 shrink-0 text-steel-300" />
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
};
