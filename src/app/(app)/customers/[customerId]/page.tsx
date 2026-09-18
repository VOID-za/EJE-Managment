'use client';

import { use, useState } from 'react';
import { asCustomerId, userFullName } from '@/domain';
import { loadJobRows } from '@/application/job-view';
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  Icon,
  LoadingPanel,
  Tabs,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { JobListTable } from '@/components/jobs/JobListTable';
import { CustomerMachinesTab } from '@/components/customers/CustomerMachinesTab';
import { CustomerOverviewTab } from '@/components/customers/CustomerOverviewTab';
import { CustomerSitesTab } from '@/components/customers/CustomerSitesTab';
import { useQuery } from '@/hooks/useQuery';
import { formatRelative } from '@/lib/format';

type TabId = 'overview' | 'sites' | 'machines' | 'jobs' | 'notes';

/**
 * The customer screen.
 *
 * Deliberately a shell: it loads the customer and hands each tab what it needs.
 * The tabs own their own editing, because company details, sites and contacts,
 * and machines are three different registers with three different rules — and a
 * single component holding all of them would be unreadable long before it was
 * finished.
 */
const CustomerDetailPage = ({
  params,
}: {
  readonly params: Promise<{ readonly customerId: string }>;
}) => {
  const { customerId } = use(params);
  const [tab, setTab] = useState<TabId>('overview');

  const query = useQuery(`customer:${customerId}`, async (repos) => {
    const id = asCustomerId(customerId);
    const customer = await repos.customers.findById(id);
    if (customer === null) return null;

    const [sites, contacts, machines, jobs, users] = await Promise.all([
      repos.customers.listSites(id),
      repos.customers.listContacts(id),
      repos.machines.list(),
      repos.jobs.list({ customerId: id }),
      repos.users.list(),
    ]);

    return {
      customer,
      sites,
      contacts,
      machines: machines.filter((machine) => machine.customerId === id),
      jobRows: await loadJobRows(repos, jobs),
      users,
    };
  });

  if (query.error !== null) {
    return <ErrorState message={query.error} onRetry={query.refetch} />;
  }
  if (query.loading) {
    return (
      <>
        <PageHeader title="Loading customer…" />
        <LoadingPanel rows={4} label="Loading customer" />
      </>
    );
  }

  const data = query.data;
  if (data === null || data === undefined) {
    return (
      <EmptyState
        title="Customer not found"
        description="This customer does not exist in the system."
        icon={<Icon name="customers" />}
      />
    );
  }

  const { customer, sites, contacts, machines, jobRows, users } = data;
  const openJobs = jobRows.filter(
    (row) => row.job.status !== 'closed' && row.job.status !== 'submitted',
  );

  return (
    <>
      <PageHeader
        title={customer.name}
        breadcrumbs={[{ label: 'Customers', href: '/customers' }, { label: customer.name }]}
        description={`${customer.industry} · Account ${customer.accountNumber}`}
        meta={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={customer.active ? 'green' : 'neutral'} dot>
              {customer.active ? 'Active account' : 'Inactive account'}
            </Badge>
            <Badge tone="outline">{sites.length} sites</Badge>
            <Badge tone="outline">{machines.length} machines</Badge>
            {openJobs.length > 0 && <Badge tone="blue">{openJobs.length} open jobs</Badge>}
          </div>
        }
      />

      <Tabs
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'sites', label: 'Sites & Contacts' },
          { id: 'machines', label: 'Machines' },
          { id: 'jobs', label: 'Job History' },
          { id: 'notes', label: 'Notes & Documents' },
        ]}
        activeId={tab}
        onChange={(id) => setTab(id as TabId)}
        className="mb-5"
      />

      {tab === 'overview' && (
        <CustomerOverviewTab
          customer={customer}
          openJobs={openJobs}
          onChanged={query.refetch}
        />
      )}

      {tab === 'sites' && (
        <CustomerSitesTab
          customer={customer}
          sites={sites}
          contacts={contacts}
          machines={machines}
          onChanged={query.refetch}
        />
      )}

      {tab === 'machines' && (
        <CustomerMachinesTab
          customer={customer}
          sites={sites}
          machines={machines}
          jobRows={jobRows}
          users={users}
          onChanged={query.refetch}
        />
      )}

      {tab === 'jobs' && (
        <JobListTable
          rows={[...jobRows].sort((a, b) => b.job.createdAt.localeCompare(a.job.createdAt))}
          emptyTitle="No jobs yet"
          emptyDescription="Jobs raised against this customer will appear here."
        />
      )}

      {tab === 'notes' && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader title="Account notes" description="Visible to the office and technicians." />
            {customer.notes.length === 0 ? (
              <p className="mt-4 text-sm text-steel-500">No notes recorded.</p>
            ) : (
              <ul className="mt-4 space-y-3">
                {customer.notes.map((note) => {
                  const author = users.find((candidate) => candidate.id === note.authorId);
                  return (
                    <li
                      key={note.id}
                      className="rounded-[var(--radius-control)] border border-steel-200 p-3"
                    >
                      <p className="text-sm leading-relaxed text-steel-700">{note.body}</p>
                      <p className="mt-2 text-xs text-steel-400">
                        {author === undefined ? 'Unknown' : userFullName(author)} ·{' '}
                        {formatRelative(note.createdAt)}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Documents"
              description="Contracts, rate agreements and site inductions."
            />
            <div className="mt-4">
              <EmptyState
                title="No documents uploaded"
                description="Customer documents will be stored here. Document storage is represented by the storage service and is simulated in this demonstration."
                icon={<Icon name="document" />}
              />
            </div>
          </Card>
        </div>
      )}
    </>
  );
};

export default CustomerDetailPage;
