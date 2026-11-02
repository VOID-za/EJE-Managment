'use client';

import Link from 'next/link';
import { Card, CardHeader } from '@/components/ui';
import { standby } from '@/api/endpoints';
import { useQuery } from '@/hooks/useQuery';
import { weekRangeLabel } from '@/components/standby/standby-format';

/**
 * THIS WEEK'S STANDBY, ON THE OVERVIEW. STANDBY-DASH-1 (2 November 2026).
 *
 * Main technician, helper and both apprentices for the current week — from the
 * PUBLISHED schedule only (a draft is never shown here), with any day an
 * approved day swap moved. Compact, and the same for every role.
 */
export const CurrentStandbyCard = () => {
  const query = useQuery('standby:current-week', () => standby.currentWeek());
  const week = query.data;
  return (
    <Card data-testid="overview-standby">
      <CardHeader
        title="Standby this week"
        description={week === null || week === undefined ? undefined : weekRangeLabel(week.weekStart)}
        action={
          <Link href="/standby" className="text-sm font-medium text-eje-700 hover:underline">
            Calendar
          </Link>
        }
      />
      {query.error !== null ? (
        <p className="text-sm text-steel-500">The standby calendar could not be loaded.</p>
      ) : week === null || week === undefined ? (
        <p className="text-sm text-steel-500">Loading…</p>
      ) : !week.published ? (
        <p className="text-sm text-steel-600" data-testid="overview-standby-empty">
          No standby schedule has been published for this week.
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-2">
            {week.places.map((place) => (
              <div key={place.position} className="min-w-0 rounded-md bg-steel-50 px-2.5 py-2" data-testid={`overview-standby-${place.position}`}>
                <dt className="text-[0.7rem] font-semibold uppercase tracking-wide text-steel-500">{place.label}</dt>
                <dd className={place.name === null ? 'truncate text-sm text-steel-400' : 'truncate text-sm font-medium text-steel-900'}>
                  {place.name ?? 'Not assigned'}
                </dd>
              </div>
            ))}
          </dl>
          {week.dayChanges.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs text-steel-600" data-testid="overview-standby-day-changes">
              {week.dayChanges.map((change) => (
                <li key={`${change.date}-${change.position}`}>
                  {change.label}: {change.name} ({week.places.find((place) => place.position === change.position)?.label})
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
};
