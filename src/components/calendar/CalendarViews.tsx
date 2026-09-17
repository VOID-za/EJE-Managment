'use client';

import Link from 'next/link';
import {
  JOB_TYPE_CODES,
  getJobTypeDefinition,
  availabilityTypeLabel,
  type IsoDate,
} from '@/domain';
import { Avatar, Badge, EmptyState, Icon, JobStatusBadge, PriorityBadge } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';
import type { CalendarEntry } from '@/application/calendar';
import { entriesOn } from '@/application/calendar';
import { CalendarEntryChip, entryClasses } from './CalendarEntryChip';
import {
  addDays,
  fromIso,
  isWeekend,
  MONTH_NAMES,
  monthRowDensity,
  packWeek,
  rangeOfDays,
  startOfWeek,
  WEEKDAY_NAMES,
} from './calendar-grid';

/**
 * Lane pitch in the month grid.
 *
 * The bar inside a lane is drawn shorter than this, but the tappable wrapper
 * fills it — so a bar stays visually light while still being a target a gloved
 * finger can hit on a rugged tablet.
 */
const LANE_HEIGHT = 23;

/** Height reserved under the bars for the "+N more" affordance. */
const MORE_ROW_HEIGHT = 20;

interface ViewProps {
  readonly entries: readonly CalendarEntry[];
  readonly anchor: IsoDate;
  readonly today: IsoDate;
  readonly onSelectDay: (date: IsoDate) => void;
  /** Opens one entry's details. Month and week views both offer this. */
  readonly onSelectEntry?: (entry: CalendarEntry) => void;
  /** Opens the full list for a day, from "+N more". */
  readonly onSelectDayEntries?: (date: IsoDate) => void;
}

/* -------------------------------------------------------------------------- */
/* Month                                                                      */
/* -------------------------------------------------------------------------- */

export const MonthView = ({
  entries,
  anchor,
  today,
  onSelectDay,
  onSelectEntry,
  onSelectDayEntries,
}: ViewProps) => {
  const month = anchor.slice(0, 7);
  const firstRow = startOfWeek(`${month}-01`);
  const rows = Array.from({ length: 6 }, (_, index) => addDays(firstRow, index * 7)).filter(
    (weekStart, index) => index < 5 || weekStart.slice(0, 7) === month,
  );

  return (
    <div className="overflow-hidden rounded-[var(--radius-card)] border border-steel-200 bg-surface">
      <div className="grid grid-cols-7 border-b border-steel-200 bg-steel-50">
        {WEEKDAY_NAMES.map((name) => (
          <div
            key={name}
            className="px-2 py-2 text-center text-[11px] font-semibold tracking-wide text-steel-500 uppercase"
          >
            {name}
          </div>
        ))}
      </div>

      {rows.map((weekStart) => {
        // The density rule lives in calendar-grid so it can be tested on its
        // own: nothing is dropped, only deferred behind "+N more".
        const { visible, lanes, hiddenByDay, hasHidden } = monthRowDensity(entries, weekStart);
        const days = rangeOfDays(weekStart, addDays(weekStart, 6));

        return (
          <div key={weekStart} className="relative border-b border-steel-100 last:border-b-0">
            <div className="grid grid-cols-7">
              {days.map((day) => {
                const outsideMonth = day.slice(0, 7) !== month;
                const isToday = day === today;

                return (
                  <button
                    key={day}
                    type="button"
                    onClick={() => onSelectDay(day)}
                    style={{
                      minHeight: `${36 + lanes * LANE_HEIGHT + (hasHidden ? MORE_ROW_HEIGHT : 6)}px`,
                    }}
                    className={cn(
                      // `items-start` matters: a button centres its content, which
                      // would drop the date pill onto the first lane of bars.
                      'flex items-start border-r border-steel-100 p-1.5 text-left transition-colors last:border-r-0 hover:bg-eje-50/40',
                      outsideMonth && 'bg-steel-50/60',
                      isWeekend(day) && !outsideMonth && 'bg-steel-50/40',
                    )}
                  >
                    <span
                      className={cn(
                        'tabular inline-flex size-6 items-center justify-center rounded-full text-xs font-semibold',
                        isToday
                          ? 'bg-action text-white'
                          : outsideMonth
                            ? 'text-steel-400'
                            : 'text-steel-700',
                      )}
                    >
                      {fromIso(day).getDate()}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Bars are absolutely positioned over the day cells so a multi-day
                entry is one continuous element rather than seven fragments. */}
            <div className="pointer-events-none absolute inset-x-0 top-[34px] px-1.5">
              {visible.map((placed) => (
                  <div
                    key={`${placed.entry.id}-${weekStart}`}
                    className="pointer-events-auto absolute flex items-center"
                    style={{
                      left: `calc(${(placed.offset / 7) * 100}% + 3px)`,
                      width: `calc(${(placed.span / 7) * 100}% - 6px)`,
                      top: `${placed.lane * LANE_HEIGHT}px`,
                      height: `${LANE_HEIGHT - 2}px`,
                    }}
                  >
                    <CalendarEntryChip
                      entry={placed.entry}
                      continuesBefore={placed.continuesBefore}
                      continuesAfter={placed.continuesAfter}
                      compact
                      onSelect={onSelectEntry}
                    />
                  </div>
              ))}

              {/* "+N more" per day, below the bars. It keeps every week row the
                  same height, and nothing is lost — the dialog it opens lists
                  the whole day. Sized as a real tap target for a tablet. */}
              {days.map((day, column) => {
                const hidden = hiddenByDay[day] ?? 0;
                if (hidden <= 0) return null;

                return (
                  <button
                    key={`more-${day}`}
                    type="button"
                    onClick={() => (onSelectDayEntries ?? onSelectDay)(day)}
                    className="pointer-events-auto absolute flex min-h-[18px] items-center justify-start rounded px-1 text-[10px] font-semibold text-steel-500 transition-colors hover:bg-steel-100 hover:text-steel-800"
                    style={{
                      left: `calc(${(column / 7) * 100}% + 3px)`,
                      width: `calc(${(1 / 7) * 100}% - 6px)`,
                      top: `${lanes * LANE_HEIGHT}px`,
                    }}
                    aria-label={`Show all ${entriesOn(entries, day).length} entries on ${day}`}
                  >
                    + {hidden} more
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Week                                                                       */
/* -------------------------------------------------------------------------- */

export const WeekView = ({
  entries,
  anchor,
  today,
  onSelectDay,
  onSelectEntry,
}: ViewProps) => {
  const weekStart = startOfWeek(anchor);
  const days = rangeOfDays(weekStart, addDays(weekStart, 6));
  const packed = packWeek(entries, weekStart);
  const lanes = Math.max(...packed.map((p) => p.lane + 1), 0);

  return (
    <div className="overflow-hidden rounded-[var(--radius-card)] border border-steel-200 bg-surface">
      <div className="grid grid-cols-7 border-b border-steel-200 bg-steel-50">
        {days.map((day) => (
          <button
            key={day}
            type="button"
            onClick={() => onSelectDay(day)}
            className={cn(
              'px-2 py-2.5 text-center transition-colors hover:bg-eje-50',
              isWeekend(day) && 'bg-steel-100/60',
            )}
          >
            <span className="block text-[11px] font-semibold tracking-wide text-steel-500 uppercase">
              {WEEKDAY_NAMES[(fromIso(day).getDay() + 6) % 7]}
            </span>
            <span
              className={cn(
                'tabular mt-1 inline-flex size-7 items-center justify-center rounded-full text-sm font-bold',
                day === today ? 'bg-action text-white' : 'text-steel-800',
              )}
            >
              {fromIso(day).getDate()}
            </span>
          </button>
        ))}
      </div>

      <div className="relative" style={{ minHeight: `${Math.max(lanes, 3) * 30 + 24}px` }}>
        <div className="absolute inset-0 grid grid-cols-7">
          {days.map((day) => (
            <div
              key={day}
              className={cn(
                'border-r border-steel-100 last:border-r-0',
                isWeekend(day) && 'bg-steel-50/50',
              )}
            />
          ))}
        </div>

        <div className="relative px-1.5 py-3">
          {packed.map((placed) => (
            <div
              key={placed.entry.id}
              className="absolute flex items-center"
              style={{
                left: `calc(${(placed.offset / 7) * 100}% + 4px)`,
                width: `calc(${(placed.span / 7) * 100}% - 8px)`,
                top: `${placed.lane * 30}px`,
                height: '26px',
              }}
            >
              <CalendarEntryChip
                entry={placed.entry}
                continuesBefore={placed.continuesBefore}
                continuesAfter={placed.continuesAfter}
                onSelect={onSelectEntry}
              />
            </div>
          ))}

          {packed.length === 0 && (
            <p className="py-6 text-center text-sm text-steel-400">Nothing scheduled this week.</p>
          )}
        </div>
      </div>
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Day                                                                        */
/* -------------------------------------------------------------------------- */

export const DayView = ({ entries, anchor }: ViewProps) => {
  const onDay = entriesOn(entries, anchor);
  const jobs = onDay.filter((entry) => entry.kind === 'job');
  const absences = onDay.filter((entry) => entry.kind === 'availability');

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <h3 className="mb-3 text-sm font-semibold text-steel-900">
          Scheduled work
          <span className="tabular ml-2 text-steel-400">{jobs.length}</span>
        </h3>

        {jobs.length === 0 ? (
          <EmptyState
            title="Nothing scheduled"
            description="No jobs are booked for this day."
            icon={<Icon name="calendar" />}
          />
        ) : (
          <ul className="space-y-2">
            {jobs.map((entry) =>
              entry.kind === 'job' ? (
                <li key={entry.id}>
                  <Link
                    href={`/jobs/${entry.jobNumber}`}
                    className="flex items-start gap-3 rounded-[var(--radius-card)] border border-steel-200 bg-surface p-4 transition-shadow hover:shadow-[var(--shadow-raised)]"
                  >
                    <span
                      className={cn(
                        'mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-control)] ring-1 ring-inset',
                        entryClasses(entry),
                      )}
                    >
                      <Icon name="jobs" className="size-5" />
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm font-bold text-steel-900">
                          {entry.jobNumber}
                        </span>
                        <Badge tone="outline" size="sm">
                          {getJobTypeDefinition(entry.jobType).label}
                        </Badge>
                        <JobStatusBadge status={entry.status} size="sm" />
                        {entry.priority === 'urgent' && (
                          <PriorityBadge priority="urgent" size="sm" />
                        )}
                        {entry.days > 1 && (
                          <Badge tone="blue" size="sm">
                            Day {rangeOfDays(entry.start, anchor).length} of {entry.days}
                          </Badge>
                        )}
                      </div>
                      <p className="mt-1 truncate text-sm font-medium text-steel-800">
                        {entry.customerName}
                      </p>
                      <p className="truncate text-xs text-steel-500">{entry.subtitle}</p>
                    </div>

                    <div className="flex shrink-0 -space-x-1.5">
                      {entry.technicianInitials.map((initials) => (
                        <Avatar key={initials} initials={initials} size="sm" />
                      ))}
                    </div>
                  </Link>
                </li>
              ) : null,
            )}
          </ul>
        )}
      </div>

      <div>
        <h3 className="mb-3 text-sm font-semibold text-steel-900">
          Technician availability
          <span className="tabular ml-2 text-steel-400">{absences.length}</span>
        </h3>

        {absences.length === 0 ? (
          <div className="rounded-[var(--radius-card)] border border-verdant-200 bg-verdant-50 p-4 text-sm text-verdant-700">
            Everybody is available.
          </div>
        ) : (
          <ul className="space-y-2">
            {absences.map((entry) =>
              entry.kind === 'availability' ? (
                <li
                  key={entry.id}
                  className="flex items-start gap-3 rounded-[var(--radius-card)] border border-steel-200 bg-surface p-3"
                >
                  <Avatar initials={entry.userInitials} size="md" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-steel-900">
                      {entry.userName}
                    </p>
                    <p className="text-xs text-steel-600">
                      {availabilityTypeLabel(entry.availabilityType)} · {entry.timeLabel}
                    </p>
                    <p className="mt-0.5 text-[11px] text-steel-400">
                      {formatDate(entry.start)}
                      {entry.days > 1 && ` – ${formatDate(entry.end)}`}
                    </p>
                    {entry.description.length > 0 && (
                      <p className="mt-1 text-xs text-steel-500">{entry.description}</p>
                    )}
                  </div>
                  <Badge
                    tone={entry.availabilityStatus === 'cancelled' ? 'neutral' : 'amber'}
                    size="sm"
                  >
                    {entry.availabilityStatus === 'cancelled' ? 'Cancelled' : 'Unavailable'}
                  </Badge>
                </li>
              ) : null,
            )}
          </ul>
        )}
      </div>
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Year                                                                       */
/* -------------------------------------------------------------------------- */

export const YearView = ({ entries, anchor, today, onSelectDay }: ViewProps) => {
  const year = anchor.slice(0, 4);

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {MONTH_NAMES.map((name, monthIndex) => {
        const monthKey = `${year}-${`${monthIndex + 1}`.padStart(2, '0')}`;
        const firstRow = startOfWeek(`${monthKey}-01`);
        const weeks = Array.from({ length: 6 }, (_, index) => addDays(firstRow, index * 7)).filter(
          (weekStart, index) => index < 5 || weekStart.slice(0, 7) === monthKey,
        );

        return (
          <div
            key={name}
            className="rounded-[var(--radius-card)] border border-steel-200 bg-surface p-3"
          >
            <p className="mb-2 text-xs font-semibold tracking-wide text-steel-700 uppercase">
              {name}
            </p>

            <div className="grid grid-cols-7 gap-0.5">
              {WEEKDAY_NAMES.map((weekday) => (
                <span
                  key={weekday}
                  className="text-center text-[9px] font-semibold text-steel-400"
                >
                  {weekday.slice(0, 1)}
                </span>
              ))}

              {weeks.flatMap((weekStart) =>
                rangeOfDays(weekStart, addDays(weekStart, 6)).map((day) => {
                  const outside = day.slice(0, 7) !== monthKey;
                  const onDay = outside ? [] : entriesOn(entries, day);
                  const jobCount = onDay.filter((entry) => entry.kind === 'job').length;
                  const hasAbsence = onDay.some(
                    (entry) => entry.kind === 'availability' && entry.blocking,
                  );

                  return (
                    <button
                      key={day}
                      type="button"
                      disabled={outside}
                      onClick={() => onSelectDay(day)}
                      title={
                        outside
                          ? undefined
                          : `${formatDate(day)} — ${jobCount} ${jobCount === 1 ? 'job' : 'jobs'}`
                      }
                      className={cn(
                        'tabular relative aspect-square rounded-[3px] text-[10px] font-medium transition-colors',
                        outside && 'invisible',
                        day === today
                          ? 'bg-action font-bold text-white'
                          : jobCount >= 3
                            ? 'bg-eje-200 text-eje-900'
                            : jobCount === 2
                              ? 'bg-eje-100 text-eje-800'
                              : jobCount === 1
                                ? 'bg-eje-50 text-eje-800'
                                : 'text-steel-500 hover:bg-steel-100',
                      )}
                    >
                      {fromIso(day).getDate()}
                      {hasAbsence && (
                        <span
                          className="absolute inset-x-1 bottom-0.5 h-0.5 rounded-full bg-amber-eje-500"
                          aria-hidden="true"
                        />
                      )}
                    </button>
                  );
                }),
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};

/** Shared legend, so the colour coding is never a guess. */
export const CalendarLegend = () => (
  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-steel-600">
    <span className="font-semibold text-steel-500">Key:</span>
    {JOB_TYPE_CODES.map((code) => {
      const definition = getJobTypeDefinition(code);
      return (
        <span key={code} className="flex items-center gap-1.5">
          <span
            className={cn(
              'size-3 rounded-sm ring-1 ring-inset',
              definition.accent === 'red'
                ? 'bg-signal-50 ring-signal-200'
                : definition.accent === 'blue'
                  ? 'bg-eje-50 ring-eje-200'
                  : definition.accent === 'green'
                    ? 'bg-verdant-50 ring-verdant-200'
                    : definition.accent === 'amber'
                      ? 'bg-amber-eje-50 ring-amber-eje-200'
                      : 'bg-violet-eje-50 ring-violet-eje-100',
            )}
          />
          {definition.label}
        </span>
      );
    })}
    <span className="flex items-center gap-1.5">
      <span className="size-3 rounded-sm bg-steel-100 ring-1 ring-steel-300 ring-inset" />
      Unavailable
    </span>
    <span className="flex items-center gap-1.5">
      <span className="size-3 rounded-sm bg-amber-eje-50 ring-1 ring-amber-eje-200 ring-inset" />
      Sick leave
    </span>
  </div>
);
