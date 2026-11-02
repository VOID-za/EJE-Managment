'use client';

import type { IsoDate } from '@/domain';
import type { StandbyWeekView } from '@/application/standby';
import { Badge, Icon } from '@/components/ui';
import { cn } from '@/lib/cn';
import { WEEKDAYS, daysOfWeek, weekRangeLabel, shortDate } from './standby-format';

const SHORT_LABELS: Record<string, string> = {
  main: 'Main',
  helper: 'Helper',
  apprentice_1: 'Apprentice 1',
  apprentice_2: 'Apprentice 2',
};

/**
 * One standby week, as a row of the month view or the body of the week view.
 *
 * The whole card is one button: tapping it opens the week's details. The four
 * places are always named — main, helper, apprentice 1, apprentice 2 — so the
 * card reads the same on a phone, a rugged tablet and a desktop.
 */
export const StandbyWeekCard = ({
  week,
  today,
  month,
  meId,
  showStatus,
  large = false,
  onOpen,
}: {
  readonly week: StandbyWeekView;
  readonly today: IsoDate;
  /** In the month view, days outside this month are muted. */
  readonly month?: string;
  readonly meId: string | null;
  /** The office sees whether a week is a draft; nobody else ever sees a draft. */
  readonly showStatus: boolean;
  readonly large?: boolean;
  readonly onOpen: () => void;
}) => {
  const draft = week.status === 'draft';
  const mine = week.places.some((place) => place.userId !== null && place.userId === meId);
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="standby-week"
      data-week={week.weekStart}
      data-status={week.status}
      aria-label={`Standby week ${weekRangeLabel(week.weekStart)}: open details`}
      className={cn(
        'block w-full rounded-[var(--radius-card)] border bg-surface p-3 text-left shadow-sm transition-colors hover:border-eje-300 focus-visible:outline-2 focus-visible:outline-eje-500 sm:p-4',
        draft ? 'border-dashed border-steel-300' : 'border-steel-200',
        week.timing === 'current' && 'ring-2 ring-eje-300',
        week.timing === 'past' && 'opacity-75',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-steel-900">{weekRangeLabel(week.weekStart)}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          {week.timing === 'current' && <Badge tone="blue" size="sm">This week</Badge>}
          {mine && <Badge tone="violet" size="sm">You are on standby</Badge>}
          {week.pendingDaySwaps.length > 0 && (
            <span data-testid="standby-week-day-pending">
              <Badge tone="amber" size="sm" dot>
                Day swap pending — not changed yet
              </Badge>
            </span>
          )}
          {week.pendingSwaps > 0 && (
            <span data-testid="standby-week-pending">
              <Badge tone="amber" size="sm" dot>
                {week.pendingSwaps === 1 ? 'Swap pending' : `${week.pendingSwaps} swaps pending`}
              </Badge>
            </span>
          )}
          {showStatus && (
            <Badge tone={draft ? 'outline' : 'green'} size="sm">
              {draft ? 'Draft — not published' : 'Published'}
            </Badge>
          )}
          {showStatus && week.problems.length > 0 && (
            <Badge tone="red" size="sm">
              {week.problems.length} {week.problems.length === 1 ? 'warning' : 'warnings'}
            </Badge>
          )}
        </div>
      </div>

      {large && (
        <ol className="mt-3 grid grid-cols-7 gap-1 text-center" aria-label="Days of this week">
          {daysOfWeek(week.weekStart).map((day, index) => (
            <li
              key={day}
              className={cn(
                'rounded-md py-1.5 text-xs',
                day === today ? 'bg-eje-600 font-semibold text-white' : 'bg-steel-50 text-steel-700',
                month !== undefined && !day.startsWith(month) && day !== today && 'text-steel-400',
              )}
            >
              <span className="block font-medium">{WEEKDAYS[index]}</span>
              <span className="tabular block">{Number(day.slice(8, 10))}</span>
            </li>
          ))}
        </ol>
      )}

      <dl className={cn('mt-3 grid gap-2', large ? 'sm:grid-cols-2' : 'grid-cols-2 lg:grid-cols-4')}>
        {week.places.map((place) => (
          <div
            key={place.position}
            data-testid={`standby-place-${place.position}`}
            className={cn(
              'min-w-0 rounded-md px-2.5 py-2',
              place.position === 'main' ? 'bg-eje-50' : 'bg-steel-50',
              place.userId !== null && place.userId === meId && 'ring-2 ring-violet-eje-500',
            )}
          >
            <dt className="text-[0.7rem] font-semibold uppercase tracking-wide text-steel-500">
              {large ? place.label : SHORT_LABELS[place.position]}
            </dt>
            <dd className={cn('truncate text-sm font-medium', place.name === null ? 'text-steel-400' : 'text-steel-900')}>
              {place.name ?? 'Not assigned'}
            </dd>
          </div>
        ))}
      </dl>
      {/* STANDBY-DAY-1: the days an approved day swap moved; every other day is as above. */}
      {week.dayChanges.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-steel-700" data-testid="standby-day-changes">
          {week.dayChanges.map((change) => (
            <li key={`${change.date}-${change.position}`} data-testid="standby-day-change" data-date={change.date} data-position={change.position}>
              <span className="font-semibold">{shortDate(change.date)}</span> — {change.label}: {change.name}
            </li>
          ))}
        </ul>
      )}
      {week.pendingDaySwaps.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-xs text-amber-eje-700" data-testid="standby-day-pending-list">
          {week.pendingDaySwaps.map((day) => (
            <li key={`${day.date}-${day.position}`}>
              {shortDate(day.date)} — {SHORT_LABELS[day.position]}: swap {day.status === 'awaiting_recipient' ? 'waiting for the other person' : 'waiting for the Office'}
            </li>
          ))}
        </ul>
      )}
      {large && (
        <p className="mt-3 flex items-center gap-1 text-sm font-semibold text-eje-700">
          Details and swaps <Icon name="chevronRight" className="size-4" />
        </p>
      )}
    </button>
  );
};
