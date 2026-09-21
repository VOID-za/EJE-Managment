'use client';

import Link from 'next/link';
import { userFullName, type User } from '@/domain';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Icon,
  JobStatusBadge,
  LoadingPanel,
  PriorityBadge,
  QueryFailure,
  SectionHeading,
  StatTile,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { JobListTable } from '@/components/jobs/JobListTable';
import { reads } from '@/api/endpoints';
import { useQuery } from '@/hooks/useQuery';
import { formatDate, formatRelative } from '@/lib/format';
import { cn } from '@/lib/cn';
import { ActivityFeed } from './ActivityFeed';
import {
  byStatus,
  jobsByPriority,
  jobsByTechnician,
  openJobs,
  overdueJobs,
  recentlyClosed,
  recentlySubmitted,
  unresolvedRefusals,
  upcomingJobs,
} from './dashboard-data';

/** Operational overview for Masters: workload, exceptions and recent movement. */
export const MasterDashboard = ({ user }: { readonly user: User }) => {
  /*
   * One read for the whole screen, composed on the server.
   *
   * Recent activity still comes through the AUTHORISED read: the server calls
   * `loadActivityFeed`, which refuses a role without `activity.viewAll`. The
   * trail has exactly one way in, and no screen can become the exception.
   */
  const jobsQuery = useQuery(`dashboard:master:${user.id}`, async () => {
    const screen = await reads.dashboard();
    return screen.office ?? { rows: [], users: [], activity: [], notifications: [] };
  });
  const supportQuery = jobsQuery;

  if (jobsQuery.error !== null) {
    return <QueryFailure code={jobsQuery.errorCode} message={jobsQuery.error} onRetry={jobsQuery.refetch} />;
  }
  if (jobsQuery.loading || supportQuery.loading) {
    return (
      <>
        <PageHeader title="Dashboard" description="Loading the current workload…" />
        <LoadingPanel rows={5} label="Loading dashboard" />
      </>
    );
  }

  const rows = jobsQuery.data?.rows ?? [];
  const users = supportQuery.data?.users ?? [];
  const activity = supportQuery.data?.activity ?? [];
  const notifications = (supportQuery.data?.notifications ?? []).filter(
    (notification) => notification.readAt === null,
  );

  const jobNumbers = new Map(rows.map((row) => [row.job.id as string, row.job.jobNumber]));

  const open = openJobs(rows);
  const inProgress = byStatus(rows, ['in_progress']);
  const awaitingSpares = byStatus(rows, ['awaiting_spares']);
  const awaitingCompletion = byStatus(rows, ['completion', 'customer_signature', 'review']);
  const overdue = overdueJobs(rows);
  const refusals = unresolvedRefusals(rows);
  const submitted = recentlySubmitted(rows);
  const closed = recentlyClosed(rows);
  const upcoming = upcomingJobs(rows);
  const technicianLoad = jobsByTechnician(rows, users);
  const priorities = jobsByPriority(rows);
  const maxPriority = Math.max(1, ...priorities.map((entry) => entry.count));

  return (
    <>
      <PageHeader
        title={`Good day, ${user.firstName}`}
        description="Live view of every open job, where each one stands and what needs attention today."
        actions={
          <>
            <Link href="/calendar">
              <Button variant="secondary" leadingIcon={<Icon name="calendar" className="size-4" />}>
                Schedule
              </Button>
            </Link>
            {/* Raising a job belongs on the Jobs screen, which is where the
                office goes to see what is already open before adding to it. */}
            <Link href="/jobs">
              <Button leadingIcon={<Icon name="jobs" className="size-4" />}>Jobs</Button>
            </Link>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Total Open Jobs"
          value={open.length}
          caption="Every job not yet submitted"
          tone="blue"
          href="/jobs?status=open-work"
          icon={<Icon name="jobs" />}
        />
        <StatTile
          label="In Progress"
          value={inProgress.length}
          caption="Technician on site or working"
          tone="violet"
          href="/jobs?status=in_progress"
          icon={<Icon name="wrench" />}
        />
        <StatTile
          label="Awaiting Spares"
          value={awaitingSpares.length}
          caption="Blocked pending parts"
          tone="amber"
          href="/jobs?status=awaiting_spares"
          icon={<Icon name="box" />}
        />
        <StatTile
          label="Awaiting Completion"
          value={awaitingCompletion.length}
          caption="Write-up, signature or review"
          tone="green"
          href="/jobs?status=awaiting_completion"
          icon={<Icon name="signature" />}
        />
      </div>

      {/*
        Its own row, because it is not a workload number like the four above —
        it is a queue of exceptions, each one a customer who turned a job card
        away and a job that cannot be issued until somebody deals with it.
        Office only: a technician has no global view of other people's refusals.
      */}
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Customer Signature Refusals"
          value={refusals.length}
          caption="Requires attention"
          tone={refusals.length > 0 ? 'red' : 'neutral'}
          href="/jobs?signatureRefusal=unresolved"
          icon={<Icon name="warning" />}
        />
      </div>

      {overdue.length > 0 && (
        <Card className="mt-6 border-signal-200 bg-signal-50/60">
          <CardHeader
            title={
              <span className="flex items-center gap-2 text-signal-700">
                <Icon name="warning" className="size-5" />
                {overdue.length} overdue {overdue.length === 1 ? 'job' : 'jobs'}
              </span>
            }
            description="Scheduled before today and still not completed."
            action={
              <Link href="/jobs?status=overdue">
                <Button variant="secondary" size="sm">
                  View all
                </Button>
              </Link>
            }
          />
          <ul className="mt-4 space-y-2">
            {overdue.slice(0, 4).map((row) => (
              <li key={row.job.id}>
                <Link
                  href={`/jobs/${row.job.jobNumber}`}
                  className="flex flex-wrap items-center gap-3 rounded-[var(--radius-control)] border border-signal-200 bg-surface px-3 py-2.5 transition-colors hover:border-signal-300"
                >
                  <span className="font-mono text-sm font-semibold text-steel-900">
                    {row.job.jobNumber}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-steel-700">
                    {row.customerName} · {row.siteName}
                  </span>
                  <span className="tabular text-xs font-semibold text-signal-600">
                    Due {formatDate(row.job.scheduledDate)}
                  </span>
                  <PriorityBadge priority={row.job.priority} size="sm" />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <div>
            <SectionHeading
              title="Today and upcoming"
              description="Scheduled work across all technicians."
              action={
                <Link href="/calendar">
                  <Button variant="ghost" size="sm" trailingIcon={<Icon name="chevronRight" className="size-4" />}>
                    Full schedule
                  </Button>
                </Link>
              }
              className="mb-3"
            />
            {upcoming.length === 0 ? (
              <EmptyState
                title="Nothing scheduled ahead"
                description="All scheduled work is either today or already complete."
              />
            ) : (
              <JobListTable rows={upcoming} />
            )}
          </div>

          <div>
            <SectionHeading
              title="Recently submitted"
              description="Signed job cards issued to customers."
              className="mb-3"
            />
            {submitted.length === 0 ? (
              <EmptyState
                title="No submitted job cards yet"
                description="Job cards appear here once a technician submits them."
              />
            ) : (
              <Card padded={false}>
                <ul className="divide-y divide-steel-100">
                  {submitted.map((row) => (
                    <li key={row.job.id}>
                      <Link
                        href={`/jobs/${row.job.jobNumber}`}
                        className="flex flex-wrap items-center gap-3 px-4 py-3 transition-colors hover:bg-steel-50"
                      >
                        <span className="font-mono text-sm font-semibold text-steel-900">
                          {row.job.jobNumber}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm text-steel-700">
                          {row.customerName}
                        </span>
                        <JobStatusBadge status={row.job.status} size="sm" />
                        <span className="text-xs text-steel-400">
                          {formatRelative(row.job.submittedAt)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>

          <div>
            <SectionHeading title="Recently closed" className="mb-3" />
            {closed.length === 0 ? (
              <EmptyState
                title="No closed jobs yet"
                description="Closed jobs appear here with their completion date."
              />
            ) : (
              <Card padded={false}>
                <ul className="divide-y divide-steel-100">
                  {closed.map((row) => (
                    <li key={row.job.id}>
                      <Link
                        href={`/jobs/${row.job.jobNumber}`}
                        className="flex flex-wrap items-center gap-3 px-4 py-3 transition-colors hover:bg-steel-50"
                      >
                        <span className="font-mono text-sm font-semibold text-steel-900">
                          {row.job.jobNumber}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm text-steel-700">
                          {row.customerName} · {row.machineLabel}
                        </span>
                        <span className="text-xs text-steel-400">
                          {formatDate(row.job.closedAt)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Jobs by priority" description="Open work only." />
            <ul className="mt-4 space-y-3">
              {priorities.map((entry) => (
                <li key={entry.priority} className="flex items-center gap-3">
                  <span className="w-16 shrink-0 text-xs font-semibold text-steel-600">
                    {entry.label}
                  </span>
                  <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-steel-100">
                    <span
                      className={cn(
                        'block h-full rounded-full',
                        entry.priority === 'urgent'
                          ? 'bg-signal-500'
                          : entry.priority === 'high'
                            ? 'bg-amber-eje-500'
                            : entry.priority === 'normal'
                              ? 'bg-eje-500'
                              : 'bg-steel-400',
                      )}
                      style={{ width: `${Math.round((entry.count / maxPriority) * 100)}%` }}
                    />
                  </span>
                  <span className="tabular w-6 shrink-0 text-right text-sm font-semibold text-steel-900">
                    {entry.count}
                  </span>
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <CardHeader title="Jobs by technician" description="Current open workload." />
            <ul className="mt-4 space-y-1">
              {technicianLoad.map((load) => (
                <li
                  key={load.technician.id}
                  className="flex items-center gap-3 rounded-[var(--radius-control)] px-2 py-2 hover:bg-steel-50"
                >
                  <Avatar initials={load.technician.initials} size="md" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-steel-900">
                      {userFullName(load.technician)}
                    </p>
                    <p className="text-xs text-steel-500">
                      {load.inProgress} in progress
                      {load.awaitingSpares > 0 && ` · ${load.awaitingSpares} awaiting spares`}
                    </p>
                  </div>
                  <span
                    className={cn(
                      'tabular inline-flex size-8 items-center justify-center rounded-full text-sm font-bold',
                      load.active === 0
                        ? 'bg-steel-100 text-steel-400'
                        : 'bg-eje-50 text-eje-700',
                    )}
                  >
                    {load.active}
                  </span>
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <CardHeader
              title="Notifications"
              description={`${notifications.length} unread`}
              action={
                <Link href="/notifications">
                  <Button variant="ghost" size="sm">
                    View all
                  </Button>
                </Link>
              }
            />
            {notifications.length === 0 ? (
              <p className="mt-4 text-sm text-steel-500">Nothing needs your attention.</p>
            ) : (
              <ul className="mt-4 space-y-2">
                {notifications.slice(0, 4).map((notification) => (
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
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Recent activity"
              action={
                <Link href="/activity">
                  <Button variant="ghost" size="sm">
                    View all
                  </Button>
                </Link>
              }
            />
            <div className="mt-4">
              <ActivityFeed events={activity} users={users} jobNumbers={jobNumbers} />
            </div>
          </Card>
        </div>
      </div>
    </>
  );
};
