'use client';

import Link from 'next/link';
import { availabilityTypeLabel, roleLabel, summariseAvailability } from '@/domain';
import { Badge, Card, EmptyState, Icon, LoadingPanel, QueryFailure } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { reads } from '@/api/endpoints';
import { useQuery } from '@/hooks/useQuery';

/**
 * USERS — WHO IS AVAILABLE. The Coordinator's Records item (the tester, 30
 * October 2026), so she manages availability without going into
 * Administration.
 *
 * AVAILABILITY ONLY. Each row says who is away today and what is booked, and
 * opens the person's page, where leave, sick leave and appointments are
 * recorded or cancelled through the existing availability operations. Nothing
 * here edits an account, a role, a password or an email address: those stay in
 * Administration, and the read behind this screen does not even carry them.
 */
const UsersPage = () => {
  const query = useQuery('staff:availability', () => reads.staff());

  return (
    <>
      <PageHeader
        title="Users"
        breadcrumbs={[{ label: 'Users' }]}
        description="Who is available, and the leave, sick leave and appointments booked. Open a person to record or cancel their availability."
      />
      {query.error !== null ? (
        <QueryFailure code={query.errorCode} message={query.error} onRetry={query.refetch} />
      ) : query.loading || query.data === null || query.data === undefined ? (
        <LoadingPanel rows={6} label="Loading users" />
      ) : query.data.rows.length === 0 ? (
        <EmptyState title="No users" description="Nobody is on the system yet." icon={<Icon name="user" />} />
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-steel-100" data-testid="users-availability">
            {query.data.rows.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-3 px-5 py-3" data-testid="users-row" data-user={row.id} data-available={row.today === null ? 'yes' : 'no'}>
                <div className="min-w-48 flex-1">
                  <Link href={`/technicians/${row.id}`} className="font-medium text-steel-900 hover:underline">
                    {row.name}
                  </Link>
                  <p className="text-xs text-steel-500">
                    {row.jobTitle || roleLabel(row.role)}
                    {row.active ? '' : ' · disabled'}
                  </p>
                </div>
                {row.today === null ? (
                  <Badge tone="green" size="sm">Available today</Badge>
                ) : (
                  <Badge tone="amber" size="sm">Away today — {availabilityTypeLabel(row.today.type)}</Badge>
                )}
                <p className="w-full text-xs text-steel-500 sm:w-auto">
                  {row.upcoming.length === 0 ? 'Nothing booked' : row.upcoming.slice(0, 2).map(summariseAvailability).join(' · ')}
                  {row.upcoming.length > 2 ? ` · and ${row.upcoming.length - 2} more` : ''}
                </p>
                <Link
                  href={`/technicians/${row.id}`}
                  className="inline-flex min-h-11 items-center rounded-[var(--radius-control)] border border-steel-300 px-3 text-sm font-medium text-steel-700 hover:border-steel-400"
                  data-testid="users-manage-availability"
                >
                  Availability
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
};

export default UsersPage;
