'use client';

import Link from 'next/link';
import type { User } from '@/domain';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Icon,
  LoadingPanel,
  QueryFailure,
  SectionHeading,
  StatTile,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { JobCardTile } from '@/components/jobs/JobCardTile';
import { reads } from '@/api/endpoints';
import { useQuery } from '@/hooks/useQuery';
import { formatRelative } from '@/lib/format';
import { byStatus, openJobs, todaysJobs, upcomingJobs } from './dashboard-data';

/**
 * Technician dashboard.
 *
 * Deliberately simple: large cards, no tables, and the day's work first. A
 * technician should be able to find the right job in one tap.
 */
export const TechnicianDashboard = ({ user }: { readonly user: User }) => {
  /*
   * One read for the whole screen.
   *
   * The server composes it, with DECISION 5 already applied: "everything this
   * technician may see" is the open pool plus their own work, which is exactly
   * the two lists below. It no longer reads every job in the business to find
   * them.
   */
  const jobsQuery = useQuery(`dashboard:tech:${user.id}`, async () => {
    const screen = await reads.dashboard();
    return screen.field ?? { mineRows: [], allRows: [], notifications: [] };
  });

  if (jobsQuery.error !== null) {
    return <QueryFailure code={jobsQuery.errorCode} message={jobsQuery.error} onRetry={jobsQuery.refetch} />;
  }
  if (jobsQuery.loading) {
    return (
      <>
        <PageHeader title="My Work" description="Loading your jobs…" />
        <LoadingPanel rows={4} label="Loading your jobs" />
      </>
    );
  }

  const mine = jobsQuery.data?.mineRows ?? [];
  const all = jobsQuery.data?.allRows ?? [];
  const unread = (jobsQuery.data?.notifications ?? []).filter(
    (notification) => notification.readAt === null,
  );

  const myOpen = openJobs(mine);
  const today = todaysJobs(mine);
  const awaitingSpares = byStatus(mine, ['awaiting_spares']);
  const upcoming = upcomingJobs(mine, 8);
  const awaitingAcceptance = mine.filter((row) => row.job.status === 'open');
  const unassigned = all.filter(
    (row) => row.job.status === 'open' && row.job.primaryTechnicianId === null,
  );
  const recentlyCompleted = mine
    .filter((row) => row.job.completedAt !== null)
    .sort((a, b) => (b.job.completedAt ?? '').localeCompare(a.job.completedAt ?? ''))
    .slice(0, 4);

  return (
    <>
      <PageHeader
        title={`Hello, ${user.firstName}`}
        description="Your jobs for today, and anything waiting on you."
        actions={
          unread.length > 0 ? (
            <Link href="/notifications">
              <Button variant="secondary" leadingIcon={<Icon name="bell" className="size-4" />}>
                {unread.length} new
              </Button>
            </Link>
          ) : undefined
        }
      />

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatTile
          label="My Jobs"
          value={myOpen.length}
          caption="Assigned and not yet submitted"
          tone="blue"
          href="/jobs?mine=1"
          icon={<Icon name="jobs" />}
        />
        <StatTile
          label="Today"
          value={today.length}
          caption="Scheduled for today"
          tone="violet"
          icon={<Icon name="calendar" />}
        />
        <StatTile
          label="Awaiting Spares"
          value={awaitingSpares.length}
          caption="Waiting on parts"
          tone="amber"
          icon={<Icon name="box" />}
        />
        <StatTile
          label="Open Jobs"
          value={unassigned.length}
          caption="Unassigned and available"
          tone="neutral"
          icon={<Icon name="plus" />}
        />
      </div>

      {awaitingAcceptance.length > 0 && (
        <div className="mt-6">
          <SectionHeading
            title="Waiting for you to accept"
            description="Accepting a job starts it immediately."
            className="mb-3"
          />
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {awaitingAcceptance.map((row) => (
              <JobCardTile key={row.job.id} row={row} />
            ))}
          </div>
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <div>
            <SectionHeading title="Today's jobs" className="mb-3" />
            {today.length === 0 ? (
              <EmptyState
                title="Nothing scheduled for today"
                description="Jobs scheduled for today will appear here as soon as they are assigned to you."
              />
            ) : (
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {today.map((row) => (
                  <JobCardTile key={row.job.id} row={row} />
                ))}
              </div>
            )}
          </div>

          {awaitingSpares.length > 0 && (
            <div>
              <SectionHeading
                title="Awaiting spares"
                description="These jobs resume as soon as the parts arrive."
                className="mb-3"
              />
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {awaitingSpares.map((row) => (
                  <JobCardTile key={row.job.id} row={row} />
                ))}
              </div>
            </div>
          )}

          <div>
            <SectionHeading title="Coming up" className="mb-3" />
            {upcoming.length === 0 ? (
              <EmptyState
                title="No upcoming jobs"
                description="Scheduled work assigned to you will appear here."
              />
            ) : (
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {upcoming.map((row) => (
                  <JobCardTile key={row.job.id} row={row} />
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader
              title="Notifications"
              description={unread.length === 0 ? 'All caught up' : `${unread.length} unread`}
              action={
                <Link href="/notifications">
                  <Button variant="ghost" size="sm">
                    View all
                  </Button>
                </Link>
              }
            />
            {unread.length === 0 ? (
              <p className="mt-4 text-sm text-steel-500">Nothing new.</p>
            ) : (
              <ul className="mt-4 space-y-2">
                {unread.slice(0, 5).map((notification) => (
                  <li
                    key={notification.id}
                    className="rounded-[var(--radius-control)] border border-steel-200 p-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-semibold text-steel-900">{notification.title}</p>
                      <Badge tone="blue" size="sm">
                        New
                      </Badge>
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-steel-500">{notification.body}</p>
                    <p className="mt-1.5 text-[11px] text-steel-400">
                      {formatRelative(notification.createdAt)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Recently completed" description="Your last few jobs." />
            {recentlyCompleted.length === 0 ? (
              <p className="mt-4 text-sm text-steel-500">
                Completed jobs will be listed here for quick reference.
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-steel-100">
                {recentlyCompleted.map((row) => (
                  <li key={row.job.id}>
                    <Link
                      href={`/jobs/${row.job.jobNumber}`}
                      className="flex items-center gap-3 py-3 transition-colors hover:text-eje-700"
                    >
                      <span className="font-mono text-sm font-semibold text-steel-900">
                        {row.job.jobNumber}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm text-steel-600">
                        {row.customerName}
                      </span>
                      <span className="text-xs text-steel-400">
                        {formatRelative(row.job.completedAt)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
};
