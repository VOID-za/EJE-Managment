'use client';

import { useMemo, useState } from 'react';
import { userFullName } from '@/domain';
import { findConflicts, loadCalendar } from '@/application/calendar';
import {
  Badge,
  Button,
  Card,
  ErrorState,
  Icon,
  LoadingPanel,
  SelectField,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import {
  CalendarLegend,
  DayView,
  MonthView,
  WeekView,
  YearView,
} from '@/components/calendar/CalendarViews';
import {
  addDays,
  addMonths,
  rangeOfDays,
  toIso,
  viewLabel,
  viewRange,
  type CalendarView,
} from '@/components/calendar/calendar-grid';
import { useQuery } from '@/hooks/useQuery';
import { cn } from '@/lib/cn';

const VIEWS: readonly { id: CalendarView; label: string }[] = [
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'year', label: 'Year' },
];

/**
 * The job schedule.
 *
 * Shows scheduled work and technician availability on one surface, because a
 * planner cannot book a job without knowing who is actually there. Data comes
 * from the application layer, so the views are pure rendering.
 */
const CalendarPage = () => {
  const today = toIso(new Date());
  const [view, setView] = useState<CalendarView>('month');
  const [anchor, setAnchor] = useState(today);
  const [technicianFilter, setTechnicianFilter] = useState('all');
  const [showLeave, setShowLeave] = useState(true);

  const range = viewRange(view, anchor);

  const query = useQuery(`calendar:${range.from}:${range.to}`, (repos) =>
    loadCalendar(repos, range),
  );

  const entries = useMemo(() => {
    const all = query.data?.entries ?? [];
    return all
      .filter((entry) => showLeave || entry.kind === 'job')
      .filter((entry) => {
        if (technicianFilter === 'all') return true;
        return entry.kind === 'job'
          ? entry.technicianIds.includes(technicianFilter)
          : entry.userId === technicianFilter;
      });
  }, [query.data, technicianFilter, showLeave]);

  const conflicts = useMemo(
    () => findConflicts(entries, rangeOfDays(range.from, range.to)),
    [entries, range.from, range.to],
  );

  const step = (direction: -1 | 1) => {
    switch (view) {
      case 'day':
        setAnchor(addDays(anchor, direction));
        break;
      case 'week':
        setAnchor(addDays(anchor, direction * 7));
        break;
      case 'month':
        setAnchor(addMonths(anchor, direction));
        break;
      case 'year':
        setAnchor(addMonths(anchor, direction * 12));
        break;
    }
  };

  if (query.error !== null) {
    return <ErrorState message={query.error} onRetry={query.refetch} />;
  }

  const jobCount = entries.filter((entry) => entry.kind === 'job').length;
  const absenceCount = entries.filter((entry) => entry.kind === 'availability').length;

  return (
    <>
      <PageHeader
        title="Calendar"
        breadcrumbs={[{ label: 'Calendar' }]}
        description="Scheduled work and technician availability on one view."
      />

      <Card className="mb-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              aria-label="Previous period"
              onClick={() => step(-1)}
            >
              <Icon name="arrowLeft" className="size-4" />
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setAnchor(today)}>
              Today
            </Button>
            <Button
              variant="secondary"
              size="sm"
              aria-label="Next period"
              onClick={() => step(1)}
            >
              <Icon name="chevronRight" className="size-4" />
            </Button>

            <h2 className="ml-2 text-lg font-semibold text-steel-900">
              {viewLabel(view, anchor)}
            </h2>
          </div>

          <div
            role="tablist"
            aria-label="Calendar view"
            className="flex gap-0.5 rounded-[var(--radius-control)] bg-steel-100 p-0.5"
          >
            {VIEWS.map((option) => (
              <button
                key={option.id}
                type="button"
                role="tab"
                aria-selected={view === option.id}
                onClick={() => setView(option.id)}
                className={cn(
                  'min-h-9 rounded-[0.45rem] px-3.5 text-sm font-semibold transition-colors',
                  view === option.id
                    ? 'bg-surface text-steel-900 shadow-sm'
                    : 'text-steel-600 hover:text-steel-900',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-end justify-between gap-4 border-t border-steel-100 pt-4">
          <div className="flex flex-wrap items-end gap-4">
            <SelectField
              containerClassName="w-60"
              label="Technician"
              value={technicianFilter}
              onChange={(event) => setTechnicianFilter(event.target.value)}
              options={[
                { value: 'all', label: 'All technicians' },
                ...(query.data?.technicians ?? []).map((technician) => ({
                  value: technician.id,
                  label: userFullName(technician),
                })),
              ]}
            />
            <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm font-medium text-steel-700">
              <input
                type="checkbox"
                checked={showLeave}
                onChange={(event) => setShowLeave(event.target.checked)}
                className="size-4.5 rounded border-steel-300 text-eje-600 focus:ring-eje-500"
              />
              Show leave &amp; availability
            </label>
          </div>

          <p className="tabular pb-3 text-sm text-steel-500">
            {jobCount} {jobCount === 1 ? 'job' : 'jobs'}
            {showLeave && ` · ${absenceCount} leave`}
          </p>
        </div>
      </Card>

      {conflicts.length > 0 && (
        <Card className="mb-5 border-amber-eje-200 bg-amber-eje-50">
          <p className="flex items-center gap-2 text-sm font-semibold text-amber-eje-700">
            <Icon name="warning" className="size-4" />
            {conflicts.length} scheduling {conflicts.length === 1 ? 'clash' : 'clashes'} in this
            period
          </p>
          <ul className="mt-2 space-y-1">
            {conflicts.slice(0, 4).map((conflict) => (
              <li
                key={`${conflict.date}-${conflict.technicianId}`}
                className="text-sm text-steel-700"
              >
                <span className="font-medium">{conflict.technicianName}</span> on {conflict.date}:{' '}
                {conflict.entries
                  .map((entry) => (entry.kind === 'job' ? entry.jobNumber : entry.subtitle))
                  .join(' + ')}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-amber-eje-700">
            Clashes are shown, not blocked — EJE double-books deliberately often enough that the
            planner should decide.
          </p>
        </Card>
      )}

      {query.loading ? (
        <LoadingPanel rows={5} label="Loading calendar" />
      ) : (
        <>
          {view === 'month' && (
            <MonthView
              entries={entries}
              anchor={anchor}
              today={today}
              onSelectDay={(date) => {
                setAnchor(date);
                setView('day');
              }}
            />
          )}
          {view === 'week' && (
            <WeekView
              entries={entries}
              anchor={anchor}
              today={today}
              onSelectDay={(date) => {
                setAnchor(date);
                setView('day');
              }}
            />
          )}
          {view === 'day' && (
            <DayView
              entries={entries}
              anchor={anchor}
              today={today}
              onSelectDay={setAnchor}
            />
          )}
          {view === 'year' && (
            <YearView
              entries={entries}
              anchor={anchor}
              today={today}
              onSelectDay={(date) => {
                setAnchor(date);
                setView('day');
              }}
            />
          )}

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <CalendarLegend />
            <Badge tone="outline" size="sm">
              Multi-day service jobs span their full booking
            </Badge>
          </div>
        </>
      )}
    </>
  );
};

export default CalendarPage;
