'use client';

import { ButtonLink, Card, CardHeader } from '@/components/ui';
import { standby } from '@/api/endpoints';
import { useQuery } from '@/hooks/useQuery';
import { weekRangeLabel } from '@/components/standby/standby-format';
import { cn } from '@/lib/cn';

type Place = { readonly position: string; readonly label: string; readonly name: string | null };

/*
 * TWO COLOUR GROUPS, NOT FOUR (the owner, 3 November 2026): the main technician
 * and the helper share the brand blue; the two apprentices share violet. A
 * coloured left edge and a light tint carry it — no solid blocks. The current
 * week is the stronger of the two; next week is lighter but just as readable.
 * Presentation only: the places, their order and the test ids are unchanged.
 */
const TONES = {
  technician: {
    current: 'border-l-eje-500 bg-eje-50',
    next: 'border-l-eje-300 bg-surface',
    label: { current: 'text-eje-700', next: 'text-eje-600' },
  },
  apprentice: {
    current: 'border-l-violet-eje-500 bg-violet-eje-50',
    next: 'border-l-violet-eje-100 bg-surface',
    label: { current: 'text-violet-eje-700', next: 'text-violet-eje-500' },
  },
} as const;

const toneOf = (position: string) => (position === 'main' || position === 'helper' ? TONES.technician : TONES.apprentice);

const Places = ({
  places,
  testid,
  current,
}: {
  readonly places: readonly Place[];
  readonly testid: string;
  readonly current: boolean;
}) => (
  <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
    {places.map((place) => {
      const tone = toneOf(place.position);
      return (
        <div
          key={place.position}
          className={cn(
            'min-w-0 rounded-md border border-steel-200 px-2.5 py-2',
            current ? 'border-l-4' : 'border-l-2',
            current ? tone.current : tone.next,
          )}
          data-testid={`${testid}-${place.position}`}
        >
          <dt className={cn('text-[0.7rem] font-semibold uppercase tracking-wide', current ? tone.label.current : tone.label.next)}>
            {place.label}
          </dt>
          <dd
            className={
              place.name === null
                ? 'truncate text-sm text-steel-400'
                : current
                  ? 'truncate text-sm font-semibold text-steel-900'
                  : 'truncate text-sm font-medium text-steel-800'
            }
          >
            {place.name ?? 'Not assigned'}
          </dd>
        </div>
      );
    })}
  </dl>
);

/**
 * THIS WEEK'S STANDBY, AT THE TOP OF THE OVERVIEW. STANDBY-DASH-1 (2 November
 * 2026); moved directly below the greeting by STANDBY-DASH-2 (3 November 2026).
 *
 * Main technician, helper and both apprentices for the current week — from the
 * PUBLISHED schedule only (a draft is never shown here), with any day an
 * approved day swap moved — then next week's places and the viewer's own
 * upcoming standby, which the Standby page used to show in a block of its own.
 * One block, the same for every role.
 */
export const CurrentStandbyCard = () => {
  const query = useQuery('standby:current-week', () => standby.currentWeek());
  const week = query.data;
  return (
    // A thin brand-blue top edge, so the block is noticed first on the Overview without growing.
    <Card className="mb-6 border-t-[3px] border-t-eje-500" data-testid="overview-standby">
      <CardHeader
        title="Standby this week"
        description={week === null || week === undefined ? undefined : weekRangeLabel(week.weekStart)}
        action={
          <ButtonLink href="/standby" variant="ghost" size="sm">
            Calendar
          </ButtonLink>
        }
      />
      {query.error !== null ? (
        <p className="text-sm text-steel-500">The standby calendar could not be loaded.</p>
      ) : week === null || week === undefined ? (
        <p className="text-sm text-steel-500">Loading…</p>
      ) : (
        <>
          {!week.published ? (
            <p className="text-sm text-steel-600" data-testid="overview-standby-empty">
              No standby schedule has been published for this week.
            </p>
          ) : (
            <Places places={week.places} testid="overview-standby" current />
          )}
          {week.published && week.dayChanges.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs text-steel-600" data-testid="overview-standby-day-changes">
              {week.dayChanges.map((change) => (
                <li key={`${change.date}-${change.position}`}>
                  {change.label}: {change.name} ({week.places.find((place) => place.position === change.position)?.label})
                </li>
              ))}
            </ul>
          )}
          {week.next !== null && (
            <div className="mt-3" data-testid="overview-standby-next">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-steel-500">Next week · {weekRangeLabel(week.next.weekStart)}</p>
              <Places places={week.next.places} testid="overview-standby-next" current={false} />
            </div>
          )}
          {week.mine.length > 0 && (
            <div className="mt-3" data-testid="overview-standby-mine">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-steel-500">Your upcoming standby</p>
              <ul className="flex flex-wrap gap-2">
                {/* Neutral, so the viewer's own weeks never read as a third role colour. */}
                {week.mine.map((place) => (
                  <li key={`${place.weekStart}-${place.position}`} className="rounded-[var(--radius-control)] border border-steel-200 bg-steel-50 px-3 py-1.5 text-sm text-steel-700">
                    <span className="block font-semibold text-steel-900">{weekRangeLabel(place.weekStart)}</span>
                    <span className="block">{place.label}</span>
                  </li>
                ))}
              </ul>
              {week.mineMore > 0 && (
                <p className="mt-1 text-xs text-steel-600">
                  and {week.mineMore} more {week.mineMore === 1 ? 'week' : 'weeks'} later — marked on the calendar.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </Card>
  );
};
