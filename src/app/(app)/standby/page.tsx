'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { addStandbyDays, isMonday, standbyWeekOf, type IsoDate } from '@/domain';
import { Badge, Button, Card, EmptyState, Icon, LoadingPanel, QueryFailure, Tabs } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { StandbyWeekCard } from '@/components/standby/StandbyWeekCard';
import { StandbyWeekDialog } from '@/components/standby/StandbyWeekDialog';
import { DaySwapDialog } from '@/components/standby/DaySwapDialog';
import { DaySwapsPanel } from '@/components/standby/DaySwapsPanel';
import { SwapRequestsPanel } from '@/components/standby/SwapRequestsPanel';
import { StandbyManagePanel } from '@/components/standby/StandbyManagePanel';
import { monthLabel, monthOf, monthWeekRange, shiftMonth, weekRangeLabel } from '@/components/standby/standby-format';
import { standby } from '@/api/endpoints';
import { useQuery } from '@/hooks/useQuery';
import { cn } from '@/lib/cn';
import { businessToday } from '@/lib/business-time';
import { useApp } from '@/providers/AppProvider';

type View = 'month' | 'week';
type Tab = 'calendar' | 'requests' | 'manage';

/**
 * THE STANDBY CALENDAR. STANDBY-2 (the owner, 2 November 2026).
 *
 * Every role: who is on standby each week — main technician, helper and the
 * two apprentices — by month or by week, with month and year navigation. A
 * week with a swap waiting for the office is marked; the published places and a
 * pending request are never confused. Technicians see their own upcoming
 * standby and ask for swaps; the office manages the year and decides swaps.
 * Everything shown and offered here is decided by the server.
 */
const StandbyPageContent = () => {
  const params = useSearchParams();
  const router = useRouter();
  const { currentUser } = useApp();
  const today = businessToday();
  const linkedWeek = params.get('week');
  const [tab, setTab] = useState<Tab>((['requests', 'manage'] as const).find((id) => id === params.get('tab')) ?? 'calendar');
  const [view, setView] = useState<View>(linkedWeek !== null && isMonday(linkedWeek) ? 'week' : 'month');
  const [anchor, setAnchor] = useState<IsoDate>(linkedWeek !== null && isMonday(linkedWeek) ? linkedWeek : today);
  const [openWeek, setOpenWeek] = useState<IsoDate | null>(null);
  const [swapFor, setSwapFor] = useState<IsoDate | null | false>(false);
  const [message, setMessage] = useState<string | null>(null);

  const range = view === 'month' ? monthWeekRange(anchor) : { from: standbyWeekOf(anchor), to: standbyWeekOf(anchor) };
  const query = useQuery(`standby:${range.from}:${range.to}`, () => standby.calendar(range.from, range.to));
  const requests = useQuery('standby-requests', () => standby.requests());
  // STANDBY-DAY-1: day swaps and their two stages.
  const daySwaps = useQuery('standby-day-swaps', () => standby.daySwaps());
  const meId = currentUser?.id ?? null;

  if (query.error !== null) return <QueryFailure code={query.errorCode} message={query.error} onRetry={query.refetch} />;

  const data = query.data;
  // What waits on THIS person: their answer, the Office's decision, and any earlier week request still pending.
  const pendingCount =
    (requests.data ?? []).filter((request) => request.status === 'pending').length +
    (daySwaps.data ?? []).filter((swap) => swap.canAnswer || swap.canDecide).length;
  const tabs = [
    { id: 'calendar', label: 'Calendar' },
    { id: 'requests', label: 'Swap requests', badge: pendingCount > 0 ? pendingCount : undefined },
    ...(data?.canManage === true ? [{ id: 'manage', label: 'Manage schedule' }] : []),
  ];
  const step = (direction: -1 | 1, unit: 'period' | 'year') => {
    if (unit === 'year') setAnchor(view === 'month' ? shiftMonth(monthOf(anchor), direction * 12) : addStandbyDays(standbyWeekOf(anchor), direction * 364));
    else setAnchor(view === 'month' ? shiftMonth(monthOf(anchor), direction) : addStandbyDays(standbyWeekOf(anchor), direction * 7));
  };
  const label = view === 'month' ? monthLabel(anchor) : weekRangeLabel(standbyWeekOf(anchor));
  const selected = data?.weeks.find((week) => week.weekStart === openWeek) ?? null;
  const done = (text: string) => {
    setMessage(text);
    setOpenWeek(null);
    setSwapFor(false);
    void daySwaps.refetch();
    void query.refetch();
  };
  const changed = (text: string) => {
    setMessage(text);
    void daySwaps.refetch();
    void requests.refetch();
    void query.refetch();
  };

  return (
    <>
      <PageHeader
        title="Standby Calendar"
        breadcrumbs={[{ label: 'Standby Calendar' }]}
        description="Who is on standby each week: the main technician, the helper and two apprentices."
        actions={
          data?.canRequestSwap === true ? (
            <Button onClick={() => setSwapFor(null)} leadingIcon={<Icon name="refresh" className="size-4" />} data-testid="standby-new-swap">
              Request a swap
            </Button>
          ) : undefined
        }
      />

      {message !== null && (
        <Card className="mb-4 border-verdant-200 bg-verdant-50">
          <p className="flex items-start justify-between gap-3 text-sm font-medium text-verdant-700" role="status" data-testid="standby-message">
            {message}
            <button type="button" className="min-h-11 shrink-0 px-2 text-steel-500" aria-label="Dismiss" onClick={() => setMessage(null)}>
              <Icon name="close" className="size-4" />
            </button>
          </p>
        </Card>
      )}

      <Tabs
        tabs={tabs}
        activeId={tab}
        onChange={(id) => {
          setTab(id as Tab);
          router.replace(id === 'calendar' ? '/standby' : `/standby?tab=${id}`);
        }}
        className="mb-5"
      />

      {tab === 'calendar' && (
        <>
          {data !== null && data.mine.length > 0 && (
            <Card className="mb-5" data-testid="standby-mine">
              <h2 className="text-sm font-semibold text-steel-900">Your upcoming standby</h2>
              <ul className="mt-2 flex flex-wrap gap-2">
                {/* The next four; the rest are on the calendar itself, so a long year does not push it off a phone screen. */}
                {data.mine.slice(0, 4).map((place) => (
                  <li key={`${place.weekStart}-${place.position}`}>
                    <button
                      type="button"
                      className="min-h-11 rounded-[var(--radius-control)] border border-violet-eje-100 bg-violet-eje-50 px-3 py-1.5 text-left text-sm text-violet-eje-700"
                      onClick={() => {
                        setView('week');
                        setAnchor(place.weekStart);
                      }}
                    >
                      <span className="block font-semibold">{weekRangeLabel(place.weekStart)}</span>
                      <span className="block">{place.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {data.mine.length > 4 && (
                <p className="mt-2 text-sm text-steel-600" data-testid="standby-mine-more">
                  and {data.mine.length - 4} more standby {data.mine.length - 4 === 1 ? 'week' : 'weeks'} later — marked on the calendar.
                </p>
              )}
            </Card>
          )}

          <Card className="mb-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <Button variant="secondary" size="sm" aria-label="Previous year" onClick={() => step(-1, 'year')} data-testid="standby-prev-year">
                  <Icon name="arrowLeft" className="size-4" />
                  <Icon name="arrowLeft" className="-ml-3 size-4" />
                </Button>
                <Button variant="secondary" size="sm" aria-label={view === 'month' ? 'Previous month' : 'Previous week'} onClick={() => step(-1, 'period')} data-testid="standby-prev">
                  <Icon name="arrowLeft" className="size-4" />
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setAnchor(today)}>
                  Today
                </Button>
                <Button variant="secondary" size="sm" aria-label={view === 'month' ? 'Next month' : 'Next week'} onClick={() => step(1, 'period')} data-testid="standby-next">
                  <Icon name="chevronRight" className="size-4" />
                </Button>
                <Button variant="secondary" size="sm" aria-label="Next year" onClick={() => step(1, 'year')} data-testid="standby-next-year">
                  <Icon name="chevronRight" className="size-4" />
                  <Icon name="chevronRight" className="-ml-3 size-4" />
                </Button>
                <h2 className="ml-1 text-lg font-semibold text-steel-900" data-testid="standby-period">
                  {label}
                </h2>
              </div>
              <div role="tablist" aria-label="Standby view" className="flex gap-0.5 rounded-[var(--radius-control)] bg-steel-100 p-0.5">
                {(['month', 'week'] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="tab"
                    aria-selected={view === option}
                    data-testid={`standby-view-${option}`}
                    onClick={() => setView(option)}
                    className={cn(
                      'min-h-9 pointer-coarse:min-h-11 rounded-[0.45rem] px-3.5 text-sm font-semibold transition-colors',
                      view === option ? 'bg-surface text-steel-900 shadow-sm' : 'text-steel-600 hover:text-steel-900',
                    )}
                  >
                    {option === 'month' ? 'Month' : 'Week'}
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2 border-t border-steel-100 pt-3 text-xs text-steel-600">
              <Badge tone="amber" size="sm" dot>Swap pending — not yet on the calendar</Badge>
              <Badge tone="violet" size="sm">You are on standby</Badge>
              {data?.canManage === true && <Badge tone="outline" size="sm">Draft — only the office sees it</Badge>}
            </div>
          </Card>

          {query.loading || data === null ? (
            <LoadingPanel rows={4} label="Loading the standby calendar" />
          ) : data.weeks.length === 0 ? (
            <EmptyState
              title={view === 'month' ? `No standby published for ${monthLabel(anchor)}` : 'No standby published for this week'}
              description={data.canManage ? 'Generate and publish the year under Manage schedule.' : 'The office has not published standby for this period yet.'}
            />
          ) : (
            <ul className="space-y-3" data-testid={`standby-${view}-view`}>
              {data.weeks.map((week) => (
                <li key={week.weekStart}>
                  <StandbyWeekCard
                    week={week}
                    today={data.today}
                    month={view === 'month' ? anchor.slice(0, 7) : undefined}
                    meId={meId}
                    showStatus={data.canManage}
                    large={view === 'week'}
                    onOpen={() => setOpenWeek(week.weekStart)}
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {tab === 'requests' &&
        (daySwaps.error !== null ? (
          <QueryFailure code={daySwaps.errorCode} message={daySwaps.error} onRetry={daySwaps.refetch} />
        ) : daySwaps.data === null ? (
          <LoadingPanel rows={3} label="Loading swap requests" />
        ) : (
          <div className="space-y-6">
            <DaySwapsPanel swaps={daySwaps.data} onChanged={changed} />
            {/* Earlier WEEK swap requests (before day swaps): kept, and still decidable while pending. */}
            {requests.data !== null && requests.data.length > 0 && (
              <section className="space-y-3" data-testid="week-swaps">
                <h2 className="text-sm font-semibold text-steel-900">Earlier week swaps</h2>
                <SwapRequestsPanel requests={requests.data} canDecide={data?.canManage === true} meId={meId} onChanged={changed} />
              </section>
            )}
          </div>
        ))}

      {tab === 'manage' && data?.canManage === true && <StandbyManagePanel today={today} onMessage={setMessage} />}

      {data !== null && (
        <StandbyWeekDialog
          week={selected}
          calendar={data}
          requests={requests.data ?? []}
          meId={meId}
          onClose={() => setOpenWeek(null)}
          onRequestSwap={(weekStart) => {
            setOpenWeek(null);
            setSwapFor(weekStart);
          }}
          onSaved={setMessage}
        />
      )}
      <DaySwapDialog open={swapFor !== false} onClose={() => setSwapFor(false)} onDone={done} />
    </>
  );
};

const StandbyPage = () => (
  <Suspense fallback={<LoadingPanel rows={4} label="Loading the standby calendar" />}>
    <StandbyPageContent />
  </Suspense>
);

export default StandbyPage;
