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
    return entry.availabilityType === 'sick_leave'
      ? 'bg-amber-eje-50 text-amber-eje-700 ring-amber-eje-200'
      : 'bg-steel-100 text-steel-600 ring-steel-300';
  }
  return JOB_TONES[getJobTypeDefinition(entry.jobType).accent] ?? JOB_TONES.blue!;
};

export const CalendarEntryChip = ({
  entry,
  continuesBefore = false,
  continuesAfter = false,
  compact = false,
}: {
  readonly entry: CalendarEntry;
  readonly continuesBefore?: boolean;
  readonly continuesAfter?: boolean;
  readonly compact?: boolean;
}) => {
  const body = (
    <span
      className={cn(
        'flex h-full w-full items-center gap-1.5 overflow-hidden px-1.5 text-[11px] font-semibold ring-1 ring-inset transition-colors',
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
          {!compact && <span className="truncate font-normal">{entry.customerName}</span>}
          {!compact && entry.technicianInitials.length > 0 && (
            <span className="ml-auto shrink-0 font-normal opacity-70">
              {entry.technicianInitials.join(' ')}
            </span>
          )}
        </>
      ) : (
        <>
          <Icon name="user" className="size-3 shrink-0 opacity-70" />
          <span className="truncate">{entry.userInitials}</span>
          <span className="truncate font-normal">
            {availabilityTypeShortLabel(entry.availabilityType)}
          </span>
          {/* A part-day absence is a different planning problem from a whole
              day, so the window shows on the bar rather than only in a tooltip. */}
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
      <Link href={`/jobs/${entry.jobNumber}`} className="block h-full w-full">
        {body}
      </Link>
    );
  }
  return body;
};
