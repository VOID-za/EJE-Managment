'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import {
  asCustomerId,
  can,
  contactFullName,
  isMachineConfirmed,
  machineDisplayName,
  userFullName,
} from '@/domain';
import { approveMachine } from '@/application/machine-operations';
import { loadJobRows } from '@/application/job-view';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardHeader,
  DefinitionGrid,
  EmptyState,
  ErrorState,
  Icon,
  LoadingPanel,
  Tabs,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { JobListTable } from '@/components/jobs/JobListTable';
import { NewMachineDialog } from '@/components/machines/NewMachineDialog';
import { useOperation } from '@/hooks/useOperation';
import { useQuery } from '@/hooks/useQuery';
import { useCurrentUser } from '@/providers/AppProvider';
import { formatDate, formatRelative } from '@/lib/format';

type TabId = 'overview' | 'sites' | 'machines' | 'jobs' | 'notes';

const CustomerDetailPage = ({
  params,
}: {
  readonly params: Promise<{ readonly customerId: string }>;
}) => {
  const { customerId } = use(params);
  const currentUser = useCurrentUser();
  const operation = useOperation();
  const [tab, setTab] = useState<TabId>('overview');
  const [addingMachine, setAddingMachine] = useState(false);

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
  const canApproveMachines = can(currentUser.role, 'machines.manage');
  const unconfirmed = machines.filter((machine) => !isMachineConfirmed(machine));
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
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader title="Company details" />
            <DefinitionGrid
              className="mt-4"
              columns={2}
              items={[
                { label: 'Registered name', value: customer.name },
                { label: 'Account number', value: customer.accountNumber },
                { label: 'Registration number', value: customer.registrationNumber },
                { label: 'VAT number', value: customer.vatNumber },
                { label: 'Telephone', value: customer.phone },
                { label: 'Email', value: customer.email },
                { label: 'Industry', value: customer.industry },
                { label: 'Payment terms', value: customer.paymentTerms },
                { label: 'Customer since', value: formatDate(customer.createdAt) },
              ]}
            />
          </Card>

          <div className="space-y-5">
            <Card>
              <CardHeader title="Head office contacts" />
              <ul className="mt-4 space-y-3">
                {contacts
                  .filter((contact) => contact.siteId === null)
                  .map((contact) => (
                    <li key={contact.id} className="flex items-start gap-3">
                      <Avatar
                        initials={`${contact.firstName[0] ?? ''}${contact.lastName[0] ?? ''}`}
                        size="md"
                      />
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-steel-900">
                          {contactFullName(contact)}
                          {contact.isPrimary && (
                            <Badge tone="blue" size="sm" className="ml-2">
                              Primary
                            </Badge>
                          )}
                        </p>
                        <p className="text-xs text-steel-500">{contact.position}</p>
                        <p className="mt-1 text-xs text-steel-600">{contact.phone}</p>
                        <p className="truncate text-xs text-steel-600">{contact.email}</p>
                      </div>
                    </li>
                  ))}
              </ul>
            </Card>

            <Card>
              <CardHeader title="Open work" />
              {openJobs.length === 0 ? (
                <p className="mt-3 text-sm text-steel-500">No open jobs for this customer.</p>
              ) : (
                <ul className="mt-3 divide-y divide-steel-100">
                  {openJobs.slice(0, 5).map((row) => (
                    <li key={row.job.id}>
                      <Link
                        href={`/jobs/${row.job.jobNumber}`}
                        className="flex items-center gap-2 py-2.5 text-sm hover:text-eje-700"
                      >
                        <span className="font-mono font-semibold text-steel-900">
                          {row.job.jobNumber}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-steel-600">
                          {row.siteName}
                        </span>
                        <Icon name="chevronRight" className="size-4 text-steel-300" />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      )}

      {tab === 'sites' && (
        <div className="space-y-5">
          {sites.map((site) => {
            const siteContacts = contacts.filter((contact) => contact.siteId === site.id);
            const siteMachines = machines.filter((machine) => machine.siteId === site.id);

            return (
              <Card key={site.id}>
                <CardHeader
                  title={site.name}
                  description={`${site.city}, ${site.province}`}
                  action={
                    <Badge tone="outline">
                      {siteMachines.length} {siteMachines.length === 1 ? 'machine' : 'machines'}
                    </Badge>
                  }
                />

                <div className="mt-4 grid grid-cols-1 gap-5 lg:grid-cols-2">
                  <div>
                    <p className="text-xs font-semibold tracking-wide text-steel-500 uppercase">
                      Address
                    </p>
                    <p className="mt-1 text-sm text-steel-700">
                      {site.addressLine1}
                      {site.addressLine2.length > 0 && (
                        <>
                          <br />
                          {site.addressLine2}
                        </>
                      )}
                      <br />
                      {site.city}, {site.province} {site.postalCode}
                    </p>
                    {site.accessNotes.length > 0 && (
                      <p className="mt-3 rounded-[var(--radius-control)] bg-eje-50 px-3 py-2 text-xs text-eje-800">
                        <span className="font-semibold">Site access: </span>
                        {site.accessNotes}
                      </p>
                    )}
                  </div>

                  <div>
                    <p className="text-xs font-semibold tracking-wide text-steel-500 uppercase">
                      Site contacts
                    </p>
                    {siteContacts.length === 0 ? (
                      <p className="mt-1 text-sm text-steel-500">
                        No site-specific contact. Head office contact applies.
                      </p>
                    ) : (
                      <ul className="mt-2 space-y-2">
                        {siteContacts.map((contact) => (
                          <li key={contact.id} className="flex items-start gap-2.5">
                            <Avatar
                              initials={`${contact.firstName[0] ?? ''}${contact.lastName[0] ?? ''}`}
                              size="sm"
                            />
                            <div className="min-w-0 text-sm">
                              <p className="font-medium text-steel-900">
                                {contactFullName(contact)}
                              </p>
                              <p className="text-xs text-steel-500">{contact.position}</p>
                              <p className="text-xs text-steel-600">
                                {contact.phone} · {contact.email}
                              </p>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {tab === 'machines' && (
        <>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-steel-500">
            Machines are reached through the customer and their sites. Every job and its history
            hangs off the machine.
          </p>
          <Button
            variant="secondary"
            leadingIcon={<Icon name="plus" className="size-4" />}
            onClick={() => setAddingMachine(true)}
          >
            Add machine
          </Button>
        </div>

        {operation.error !== null && (
          <p role="alert" className="mb-4 text-sm font-medium text-signal-600">
            {operation.error}
          </p>
        )}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {machines.length === 0 ? (
            <div className="md:col-span-2 xl:col-span-3">
              <EmptyState
                title="No machines recorded"
                description="Machines captured against this customer will appear here."
                icon={<Icon name="machines" />}
              />
            </div>
          ) : (
            machines.map((machine) => {
              const site = sites.find((candidate) => candidate.id === machine.siteId);
              const machineJobs = jobRows.filter((row) => row.job.machineId === machine.id);
              return (
                <Link key={machine.id} href={`/machines/${machine.id}`} className="group block">
                  <Card className="h-full transition-shadow group-hover:shadow-[var(--shadow-raised)]">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-base font-semibold text-steel-900">
                          {machineDisplayName(machine)}
                        </p>
                        <p className="truncate font-mono text-xs text-steel-500">
                          {machine.serialNumber}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <Badge tone="outline" size="sm">
                          {machine.year}
                        </Badge>
                        {!isMachineConfirmed(machine) && (
                          <Badge tone="amber" size="sm" dot>
                            Awaiting approval
                          </Badge>
                        )}
                      </div>
                    </div>
                    <DefinitionGrid
                      className="mt-4"
                      columns={1}
                      items={[
                        { label: 'Type', value: machine.machineType },
                        { label: 'Site', value: site?.name ?? '—' },
                        { label: 'Control', value: machine.controlSystem },
                        { label: 'Installed', value: formatDate(machine.installationDate) },
                      ]}
                    />
                    <p className="mt-4 border-t border-steel-100 pt-3 text-xs text-steel-500">
                      {machineJobs.length} {machineJobs.length === 1 ? 'job' : 'jobs'} on record
                    </p>
                  </Card>
                </Link>
              );
            })
          )}
        </div>

        {/* Approval sits outside the card links so the button is not a nested anchor. */}
        {canApproveMachines && unconfirmed.length > 0 && (
          <Card className="mt-4">
            <CardHeader
              title="Awaiting your approval"
              description="Added on site by a technician. Confirm each one onto the official register."
            />
            <ul className="mt-3 divide-y divide-steel-100">
              {unconfirmed.map((machine) => (
                <li
                  key={machine.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3"
                >
                  <div className="min-w-0">
                    <p className="font-semibold text-steel-900">{machineDisplayName(machine)}</p>
                    <p className="font-mono text-xs text-steel-500">{machine.serialNumber}</p>
                    <p className="mt-0.5 text-xs text-steel-500">
                      Added by{' '}
                      {(() => {
                        const author = users.find(
                          (candidate) => candidate.id === machine.createdBy,
                        );
                        return author === undefined ? 'a technician' : userFullName(author);
                      })()}{' '}
                      · {formatRelative(machine.createdAt)}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    loading={operation.running}
                    onClick={async () => {
                      const ok = await operation.run((context) =>
                        approveMachine(context, machine),
                      );
                      if (ok) query.refetch();
                    }}
                  >
                    Confirm on register
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <NewMachineDialog
          open={addingMachine}
          customerId={customer.id}
          sites={sites}
          onClose={() => setAddingMachine(false)}
          onCreated={() => {
            setAddingMachine(false);
            query.refetch();
          }}
        />
        </>
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
