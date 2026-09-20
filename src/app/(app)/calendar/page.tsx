'use client';

import { useMemo, useState } from 'react';
import {
  JOB_TYPE_CODES,
  jobTypeLabel,
  userFullName,
  type IsoDate,
  type JobTypeCode,
} from '@/domain';
import { entriesOn, findConflicts, type CalendarEntry } from '@/application/calendar';
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
import { CalendarEntryDetail } from '@/components/calendar/CalendarEntryDetail';
import { DayEntriesDialog } from '@/components/calendar/DayEntriesDialog';
import {
  addDays,
  addMonths,
  rangeOfDays,
  toIso,
  viewLabel,
  viewRange,
  type CalendarView,
} from '@/components/calendar/calendar-grid';
import { reads } from '@/api/endpoints';
import { useQuery } from '@/hooks/useQuery';
import { cn } from '@/lib/cn';

const VIEWS: readonly { id: CalendarView; label: string }[] = [
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'year', label: 'Year' },
];

/**
 * What the calendar is showing.
 *
 * Three states rather than a checkbox, because the two questions a planner
 * actually asks are different ones: "what work is on?" and "who is out?".
 */
type ShowFilter = 'all' | 'jobs' | 'availability';

const SHOW_FILTERS: readonly { id: ShowFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'jobs', label: 'Jobs' },
  { id: 'availability', label: 'Availability' },
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
  const [show, setShow] = useState<ShowFilter>('all');
  const [jobTypeFilter, setJobTypeFilter] = useState<JobTypeCode | 'all'>('all');
  const [detail, setDetail] = useState<CalendarEntry | null>(null);
  const [dayList, setDayList] = useState<IsoDate | null>(null);

  const range = viewRange(view, anchor);

  const query = useQuery(`calendar:${range.from}:${range.to}`, () =>
    reads.calendar(range.from, range.to),
  );

  const entries = useMemo(() => {
    const all = query.data?.entries ?? [];
    return all
      .filter((entry) => show === 'all' || (show === 'jobs') === (entry.kind === 'job'))
      // A job-type filter narrows the work without hiding who is out, which is
      // what you want when checking cover for one kind of job.
      .filter(
        (entry) =>
          jobTypeFilter === 'all' || entry.kind !== 'job' || entry.jobType === jobTypeFilter,
      )
      .filter((entry) => {
        if (technicianFilter === 'all') return true;
        return entry.kind === 'job'
          ? entry.technicianIds.includes(technicianFilter)
          : entry.userId === technicianFilter;
      });
  }, [query.data, technicianFilter, show, jobTypeFilter]);

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
            {/* Three lightweight controls, no panel: what to show, which kind of
                work, and whose. Enough to answer a planner's questions without
                becoming a screen of its own. */}
            <div>
              <span className="mb-1.5 block text-sm font-semibold text-steel-700">Show</span>
              <div
                role="group"
                aria-label="Show on calendar"
                className="flex gap-0.5 rounded-[var(--radius-control)] bg-steel-100 p-0.5"
              >
                {SHOW_FILTERS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={show === option.id}
                    onClick={() => setShow(option.id)}
                    className={cn(
                      'min-h-9 rounded-[0.45rem] px-3 text-sm font-semibold transition-colors',
                      show === option.id
                        ? 'bg-surface text-steel-900 shadow-sm'
                        : 'text-steel-600 hover:text-steel-900',
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <SelectField
              containerClassName="w-44"
              label="Job type"
              value={jobTypeFilter}
              onChange={(event) => setJobTypeFilter(event.target.value as JobTypeCode | 'all')}
              disabled={show === 'availability'}
              options={[
                { value: 'all', label: 'All types' },
                ...JOB_TYPE_CODES.map((code) => ({ value: code, label: jobTypeLabel(code) })),
              ]}
            />

            <SelectField
              containerClassName="w-52"
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
          </div>

          <p className="tabular pb-3 text-sm text-steel-500">
            {jobCount} {jobCount === 1 ? 'job' : 'jobs'}
            {show !== 'jobs' && ` · ${absenceCount} unavailable`}
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
              onSelectEntry={setDetail}
              onSelectDayEntries={setDayList}
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
              onSelectEntry={setDetail}
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

      {/* Progressive disclosure: the grid stays an overview, and the detail
          lives one tap away rather than inside each cell. */}
      {dayList !== null && (
        <DayEntriesDialog
          date={dayList}
          entries={entriesOn(entries, dayList)}
          onSelect={(entry) => {
            setDayList(null);
            setDetail(entry);
          }}
          onOpenDay={() => {
            setAnchor(dayList);
            setView('day');
            setDayList(null);
          }}
          onClose={() => setDayList(null)}
        />
      )}

      {detail !== null && (
        <CalendarEntryDetail entry={detail} onClose={() => setDetail(null)} />
      )}
    </>
  );
};

export default CalendarPage;
