import Link from 'next/link';
import { availabilityTypeShortLabel, getJobTypeDefinition } from '@/domain';
import { Icon } from '@/components/ui';
import { cn } from '@/lib/cn';
import type { CalendarEntry } from '@/application/calendar';

/**
 * A single bar on the calendar.
 *
 * Colour carries meaning: job type for work, a muted grey for absence, and the
 * urgent red used everywhere else in the system. Absence is deliberately
 * quieter than work — a planner scans for jobs first — but never invisible, and
 * a cancelled record is struck through so it cannot be mistaken for a live one.
 *
 * What a bar SHOWS depends on how much room the view has. In `compact` (month)
 * a job is its number and nothing else, and an absence is initials plus a short
 * type; everything further is one tap away. Week and day views have the space to
 * carry the customer and the technicians as well.
 */
const JOB_TONES: Record<string, string> = {
  red: 'bg-signal-50 text-signal-700 ring-signal-200 hover:bg-signal-100',
  blue: 'bg-eje-50 text-eje-800 ring-eje-200 hover:bg-eje-100',
  green: 'bg-verdant-50 text-verdant-700 ring-verdant-200 hover:bg-verdant-100',
  violet: 'bg-violet-eje-50 text-violet-eje-700 ring-violet-eje-100 hover:bg-violet-eje-100',
  amber: 'bg-amber-eje-50 text-amber-eje-700 ring-amber-eje-200 hover:bg-amber-eje-100',
};

export const entryClasses = (entry: CalendarEntry): string => {
  if (entry.kind === 'availability') {
    if (entry.availabilityStatus === 'cancelled') {
      return 'bg-steel-50 text-steel-400 ring-steel-200 line-through';
    }
    // Flatter and greyer than any job tone, so several absences on one day
    // cannot out-shout the work.
    return entry.availabilityType === 'sick_leave'
      ? 'bg-amber-eje-50/70 text-amber-eje-700 ring-amber-eje-100'
      : 'bg-steel-100/80 text-steel-500 ring-steel-200/70';
  }
  return JOB_TONES[getJobTypeDefinition(entry.jobType).accent] ?? JOB_TONES.blue!;
};

export const CalendarEntryChip = ({
  entry,
  continuesBefore = false,
  continuesAfter = false,
  compact = false,
  onSelect,
}: {
  readonly entry: CalendarEntry;
  readonly continuesBefore?: boolean;
  readonly continuesAfter?: boolean;
  readonly compact?: boolean;
  /**
   * Opens the entry's details. Supplied for availability, which has no page of
   * its own; a job keeps its link straight to the job card.
   */
  readonly onSelect?: (entry: CalendarEntry) => void;
}) => {
  const isAvailability = entry.kind === 'availability';

  const body = (
    <span
      className={cn(
        'flex w-full shrink-0 items-center gap-1.5 overflow-hidden ring-1 ring-inset transition-colors',
        // Both sit shorter than their lane so the wrapper carries the tap area,
        // and absence sits shorter still than work — the difference reads as
        // weight rather than as misalignment.
        isAvailability
          ? 'h-[15px] text-[10px] font-medium'
          : 'h-[18px] text-[11px] font-semibold',
        isAvailability ? 'px-1' : 'px-1.5',
        compact ? 'rounded-sm' : 'rounded-[5px]',
        continuesBefore ? 'rounded-l-none' : '',
        continuesAfter ? 'rounded-r-none' : '',
        entryClasses(entry),
      )}
      title={`${entry.title} — ${entry.subtitle}`}
    >
      {continuesBefore && <span className="shrink-0 opacity-60">◀</span>}

      {entry.kind === 'job' ? (
        <>
          {entry.priority === 'urgent' && (
            <Icon name="warning" className="size-3 shrink-0 text-signal-600" />
          )}
          <span className="truncate">{entry.jobNumber}</span>
          {/* Month view stops at the job number; the rest is one tap away. */}
          {!compact && <span className="truncate font-normal">{entry.customerName}</span>}
          {!compact && entry.technicianInitials.length > 0 && (
            <span className="ml-auto shrink-0 font-normal opacity-70">
              {entry.technicianInitials.join(' ')}
            </span>
          )}
        </>
      ) : (
        <>
          <Icon name="user" className="size-2.5 shrink-0 opacity-60" />
          <span className="truncate">{entry.userInitials}</span>
          <span className="truncate font-normal">
            {availabilityTypeShortLabel(entry.availabilityType)}
          </span>
          {/* A part-day absence is a different planning problem from a whole
              day, so the window shows on the bar outside the month grid. */}
          {!entry.allDay && !compact && (
            <span className="ml-auto shrink-0 text-[10px] font-normal opacity-80">
              {entry.timeLabel}
            </span>
          )}
        </>
      )}

      {continuesAfter && <span className="ml-auto shrink-0 opacity-60">▶</span>}
    </span>
  );

  if (entry.kind === 'job') {
    return (
      <Link
        href={`/jobs/${entry.jobNumber}`}
        className="flex h-full w-full items-center"
        aria-label={`${entry.jobNumber} — ${entry.subtitle}`}
      >
        {body}
      </Link>
    );
  }

  if (onSelect === undefined) return body;

  return (
    <button
      type="button"
      onClick={() => onSelect(entry)}
      className="flex h-full w-full items-center"
      aria-label={`${entry.userName} — ${entry.subtitle}`}
    >
      {body}
    </button>
  );
};
