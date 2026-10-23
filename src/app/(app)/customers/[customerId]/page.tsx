'use client';

import { use, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Icon,
  LoadingPanel,
  QueryFailure,
  Tabs,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { JobListTable } from '@/components/jobs/JobListTable';
import { CustomerMachinesTab } from '@/components/customers/CustomerMachinesTab';
import { CustomerOverviewTab } from '@/components/customers/CustomerOverviewTab';
import { CustomerSitesTab } from '@/components/customers/CustomerSitesTab';
import { ChangeRequestDialog } from '@/components/customers/ChangeRequestDialog';
import { ChangeRequestsPanel } from '@/components/customers/ChangeRequestsPanel';
import { CustomerDocumentsPanel } from '@/components/customers/CustomerDocumentsPanel';
import { CustomerNotesPanel } from '@/components/customers/CustomerNotesPanel';
import { reads } from '@/api/endpoints';
import { useQuery } from '@/hooks/useQuery';
import { useCurrentUser } from '@/providers/AppProvider';
import { can } from '@/domain';

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
  const [reporting, setReporting] = useState(false);
  const currentUser = useCurrentUser();

  const query = useQuery(`customer:${customerId}`, () => reads.customer(customerId));

  if (query.error !== null) {
    return <QueryFailure code={query.errorCode} message={query.error} onRetry={query.refetch} />;
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

  const { customer, sites, contacts, machines, jobRows, users, changeRequests, documents } =
    data;
  /*
   * WHO SEES WHICH HALF OF CUST-CR. The office acts on reports, so they see the
   * panel; everybody who can read the register may RAISE one, which is the
   * whole point — the person who cannot edit a record is the one standing in
   * front of it. The server decides both again.
   */
  const manages = currentUser !== null && can(currentUser.role, 'customers.manage');
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
            {/*
              CUST-CR. Offered to everybody who can read this screen, including
              a technician who cannot change a word of it — which is exactly who
              notices that a serial number is wrong.
            */}
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setReporting(true)}
              data-testid="report-register-problem"
            >
              Report a problem
            </Button>
          </div>
        }
      />

      <ChangeRequestDialog
        customer={customer}
        sites={sites}
        machines={machines}
        open={reporting}
        onClose={() => setReporting(false)}
        onRaised={query.refetch}
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
        <div className="space-y-5">
          <CustomerOverviewTab
            customer={customer}
            openJobs={openJobs}
            onChanged={query.refetch}
          />

          {manages && (
            <ChangeRequestsPanel
              requests={changeRequests}
              users={users}
              onChanged={query.refetch}
            />
          )}

        </div>
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

      {/*
        NOTES AND DOCUMENTS, AND BOTH OF THEM REAL. Customers §2.

        This tab used to be the one place on the screen that lied. The notes
        were rendered with no way to add one — for any role, Master included —
        and beside them sat a Documents card that said "No documents uploaded …
        storage is simulated in this demonstration", hard-coded, while the REAL
        documents panel was on the Overview tab holding real stored files. A
        Coordinator asked to keep account notes and file paperwork came to the
        tab named for both and found neither.

        So the real panels are here, where their names say they are, and the
        card that claimed otherwise is gone. Both are office work
        (`customers.manage` — a Master or a Coordinator) and the server refuses
        them to anybody else regardless: a technician's own response carries no
        documents at all.
      */}
      {tab === 'notes' && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <CustomerNotesPanel
            customer={customer}
            users={users}
            canManage={manages}
            onChanged={query.refetch}
          />

          {manages ? (
            <CustomerDocumentsPanel
              customerId={customer.id}
              documents={documents}
              users={users}
              onChanged={query.refetch}
            />
          ) : (
            <Card>
              <CardHeader
                title="Documents"
                description="Contracts, rate agreements and site inductions."
              />
              <div className="mt-4">
                <EmptyState
                  title="The office holds these"
                  description="A customer's filed paperwork is read by the office. Raise a change request if something here is wrong."
                  icon={<Icon name="document" />}
                />
              </div>
            </Card>
          )}
        </div>
      )}
    </>
  );
};

export default CustomerDetailPage;
