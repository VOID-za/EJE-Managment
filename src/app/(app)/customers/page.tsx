'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { can } from '@/domain';
import {
  Badge,
  Button,
  Card,
  DataTable,
  ErrorState,
  Icon,
  LoadingPanel,
  type Column,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { NewCustomerDialog } from '@/components/customers/NewCustomerDialog';
import { reads } from '@/api/endpoints';
import { useQuery } from '@/hooks/useQuery';
import { useCurrentUser } from '@/providers/AppProvider';

interface CustomerRow {
  readonly id: string;
  readonly name: string;
  readonly accountNumber: string;
  readonly industry: string;
  readonly siteCount: number;
  readonly machineCount: number;
  readonly openJobs: number;
  readonly active: boolean;
}

const CustomersPage = () => {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const [term, setTerm] = useState('');
  const [adding, setAdding] = useState(false);
  // The official customer record belongs to the office, so only a Master adds one.
  const canManage = can(currentUser.role, 'customers.manage');

  const query = useQuery('customers:list', () => reads.customers());

  const rows = useMemo(() => {
    const needle = term.trim().toLowerCase();
    return (query.data ?? []).filter(
      (row) =>
        needle.length === 0 ||
        row.name.toLowerCase().includes(needle) ||
        row.accountNumber.toLowerCase().includes(needle) ||
        row.industry.toLowerCase().includes(needle),
    );
  }, [query.data, term]);

  const columns: Column<CustomerRow>[] = [
    {
      key: 'name',
      header: 'Customer',
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate font-semibold text-steel-900">{row.name}</p>
          <p className="truncate font-mono text-xs text-steel-500">{row.accountNumber}</p>
        </div>
      ),
    },
    { key: 'industry', header: 'Industry', secondary: true, render: (row) => row.industry },
    {
      key: 'sites',
      header: 'Sites',
      align: 'right',
      render: (row) => <span className="tabular">{row.siteCount}</span>,
    },
    {
      key: 'machines',
      header: 'Machines',
      align: 'right',
      render: (row) => <span className="tabular">{row.machineCount}</span>,
    },
    {
      key: 'openJobs',
      header: 'Open jobs',
      align: 'right',
      render: (row) =>
        row.openJobs === 0 ? (
          <span className="text-steel-400">—</span>
        ) : (
          <Badge tone="blue" size="sm">
            {row.openJobs}
          </Badge>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <Badge tone={row.active ? 'green' : 'neutral'} size="sm" dot>
          {row.active ? 'Active' : 'Inactive'}
        </Badge>
      ),
    },
    {
      key: 'chevron',
      header: '',
      align: 'right',
      width: '48px',
      render: () => <Icon name="chevronRight" className="size-4 text-steel-300" />,
    },
  ];

  if (query.error !== null) {
    return <ErrorState message={query.error} onRetry={query.refetch} />;
  }

  return (
    <>
      <PageHeader
        title="Customers"
        breadcrumbs={[{ label: 'Customers' }]}
        description="Every EJE customer, their sites, machines and open work."
        actions={
          canManage ? (
            <Button
              leadingIcon={<Icon name="plus" className="size-4" />}
              onClick={() => setAdding(true)}
            >
              Add customer
            </Button>
          ) : undefined
        }
      />

      <Card className="mb-5">
        <label htmlFor="customer-search" className="mb-1.5 block text-sm font-semibold text-steel-700">
          Search customers
        </label>
        <div className="relative max-w-lg">
          <Icon
            name="search"
            className="pointer-events-none absolute top-1/2 left-3 size-[18px] -translate-y-1/2 text-steel-400"
          />
          <input
            id="customer-search"
            type="search"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="Name, account number or industry"
            className="h-11 w-full rounded-[var(--radius-control)] border border-steel-300 bg-surface pr-3 pl-10 text-sm placeholder:text-steel-400 hover:border-steel-400 focus:border-eje-500 focus:ring-2 focus:ring-eje-100 focus:outline-none"
          />
        </div>
      </Card>

      {query.loading ? (
        <LoadingPanel rows={5} label="Loading customers" />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          onRowClick={(row) => router.push(`/customers/${row.id}`)}
          emptyTitle="No customers found"
          emptyDescription="No customer matches that search."
        />
      )}

      {canManage && (
        <NewCustomerDialog
          open={adding}
          onClose={() => setAdding(false)}
          onCreated={(customerId) => {
            setAdding(false);
            query.refetch();
            router.push(`/customers/${customerId}`);
          }}
        />
      )}
    </>
  );
};

export default CustomersPage;
