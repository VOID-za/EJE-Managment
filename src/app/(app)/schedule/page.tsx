'use client';

import { useMemo, useState } from 'react';
import { asUserId, isJobOpenWork, userFullName } from '@/domain';
import { loadJobRows, type JobListRow } from '@/application/job-view';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Icon,
  LoadingPanel,
  SelectField,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { JobCardTile } from '@/components/jobs/JobCardTile';
import { useQuery } from '@/hooks/useQuery';
import { isOverdue } from '@/lib/format';
import { cn } from '@/lib/cn';

const DAYS_AHEAD = 14;

const startOfToday = (): Date => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
};

const isoFor = (offset: number): string => {
  const date = startOfToday();
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}-${`${date.getDate()}`.padStart(2, '0')}`;
};

const dayLabel = (offset: number): string => {
  if (offset === 0) return 'Today';
  if (offset === 1) return 'Tomorrow';
  const date = startOfToday();
  date.setDate(date.getDate() + offset);
  return new Intl.DateTimeFormat('en-ZA', {
    weekday: 'long',
    day: '2-digit',
    month: 'short',
  }).format(date);
};

/** Forward-looking schedule, grouped by day, with overdue work surfaced first. */
const SchedulePage = () => {
  const [technician, setTechnician] = useState('all');

  const query = useQuery('schedule', async (repos) => {
    const jobs = await repos.jobs.list();
    const [rows, users] = await Promise.all([loadJobRows(repos, jobs), repos.users.list()]);
    return { rows, users };
  });

  const rows = useMemo(
    () =>
      (query.data?.rows ?? []).filter(
        (row) =>
          isJobOpenWork(row.job.status) &&
          (technician === 'all' ||
            row.job.primaryTechnicianId === technician ||
            row.job.additionalTechnicianIds.includes(asUserId(technician))),
      ),
    [query.data?.rows, technician],
  );

  const overdue = rows.filter((row) => isOverdue(row.job.scheduledDate));
  const unscheduled = rows.filter((row) => row.job.scheduledDate === null);

  const days = useMemo(() => {
    const result: { offset: number; iso: string; jobs: JobListRow[] }[] = [];
    for (let offset = 0; offset < DAYS_AHEAD; offset += 1) {
      const iso = isoFor(offset);
      result.push({
        offset,
        iso,
        jobs: rows.filter((row) => row.job.scheduledDate === iso),
      });
    }
    return result;
  }, [rows]);

  if (query.error !== null) {
    return <ErrorState message={query.error} onRetry={query.refetch} />;
  }

  return (
    <>
      <PageHeader
        title="Schedule"
        breadcrumbs={[{ label: 'Schedule' }]}
        description={`Open work for the next ${DAYS_AHEAD} days, grouped by day.`}
      />

      <Card className="mb-5">
        <SelectField
          containerClassName="max-w-sm"
          label="Technician"
          value={technician}
          onChange={(event) => setTechnician(event.target.value)}
          options={[
            { value: 'all', label: 'All technicians' },
            ...(query.data?.users ?? [])
              .filter((user) => user.role === 'technician' && user.active)
              .map((user) => ({ value: user.id, label: userFullName(user) })),
          ]}
        />
      </Card>

      {query.loading ? (
        <LoadingPanel rows={5} label="Loading schedule" />
      ) : (
        <div className="space-y-6">
          {overdue.length > 0 && (
            <section>
              <div className="mb-3 flex items-center gap-2">
                <h2 className="text-lg font-semibold text-signal-700">Overdue</h2>
                <Badge tone="red" size="sm">
                  {overdue.length}
                </Badge>
              </div>
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
                {overdue.map((row) => (
                  <JobCardTile key={row.job.id} row={row} />
                ))}
              </div>
            </section>
          )}

          {days.map((day) => (
            <section key={day.iso}>
              <div className="mb-3 flex items-center gap-3">
                <h2
                  className={cn(
                    'text-lg font-semibold',
                    day.offset === 0 ? 'text-eje-700' : 'text-steel-900',
                  )}
                >
                  {dayLabel(day.offset)}
                </h2>
                <span className="h-px flex-1 bg-steel-200" aria-hidden="true" />
                <span className="tabular text-sm text-steel-500">
                  {day.jobs.length} {day.jobs.length === 1 ? 'job' : 'jobs'}
                </span>
              </div>

              {day.jobs.length === 0 ? (
                <p className="rounded-[var(--radius-control)] border border-dashed border-steel-300 px-4 py-3 text-sm text-steel-400">
                  Nothing scheduled.
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
                  {day.jobs.map((row) => (
                    <JobCardTile key={row.job.id} row={row} />
                  ))}
                </div>
              )}
            </section>
          ))}

          {unscheduled.length > 0 && (
            <section>
              <div className="mb-3 flex items-center gap-2">
                <h2 className="text-lg font-semibold text-steel-900">Not yet scheduled</h2>
                <Badge tone="neutral" size="sm">
                  {unscheduled.length}
                </Badge>
              </div>
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
                {unscheduled.map((row) => (
                  <JobCardTile key={row.job.id} row={row} />
                ))}
              </div>
            </section>
          )}

          {rows.length === 0 && (
            <EmptyState
              title="No open work scheduled"
              description="Jobs scheduled in the next two weeks will appear here."
              icon={<Icon name="calendar" />}
            />
          )}
        </div>
      )}
    </>
  );
};

export default SchedulePage;
