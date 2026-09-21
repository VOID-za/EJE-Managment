'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { type MachineType } from '@/domain';
import {
  Badge,
  Card,
  DataTable,
  Icon,
  LoadingPanel,
  QueryFailure,
  SelectField,
  type Column,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { reads } from '@/api/endpoints';
import { useQuery } from '@/hooks/useQuery';
import { formatDate } from '@/lib/format';

interface MachineRow {
  readonly id: string;
  readonly label: string;
  readonly serialNumber: string;
  readonly machineNumber: string;
  readonly machineType: MachineType;
  readonly manufacturer: string;
  readonly customerName: string;
  readonly siteName: string;
  readonly year: number;
  readonly installationDate: string;
  readonly openJobs: number;
}

const MachinesPage = () => {
  const router = useRouter();
  const [term, setTerm] = useState('');
  const [manufacturer, setManufacturer] = useState('all');

  const query = useQuery('machines:list', () => reads.machines());

  const manufacturers = useMemo(
    () => [...new Set((query.data ?? []).map((row) => row.manufacturer))].sort(),
    [query.data],
  );

  const rows = useMemo(() => {
    const needle = term.trim().toLowerCase();
    return (query.data ?? [])
      .filter((row) => manufacturer === 'all' || row.manufacturer === manufacturer)
      .filter(
        (row) =>
          needle.length === 0 ||
          row.label.toLowerCase().includes(needle) ||
          row.serialNumber.toLowerCase().includes(needle) ||
          row.machineNumber.toLowerCase().includes(needle) ||
          row.customerName.toLowerCase().includes(needle) ||
          row.siteName.toLowerCase().includes(needle),
      );
  }, [query.data, term, manufacturer]);

  const columns: Column<MachineRow>[] = [
    {
      key: 'machine',
      header: 'Machine',
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate font-semibold text-steel-900">
            {row.machineNumber.length > 0 && (
              <Badge tone="blue" size="sm" className="mr-2">
                {row.machineNumber}
              </Badge>
            )}
            {row.label}
          </p>
          <p className="truncate font-mono text-xs text-steel-500">{row.serialNumber}</p>
        </div>
      ),
    },
    { key: 'type', header: 'Type', secondary: true, render: (row) => row.machineType },
    {
      key: 'customer',
      header: 'Customer / Site',
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate text-steel-800">{row.customerName}</p>
          <p className="truncate text-xs text-steel-500">{row.siteName}</p>
        </div>
      ),
    },
    {
      key: 'year',
      header: 'Year',
      align: 'right',
      secondary: true,
      render: (row) => <span className="tabular">{row.year}</span>,
    },
    {
      key: 'installed',
      header: 'Installed',
      secondary: true,
      render: (row) => <span className="tabular">{formatDate(row.installationDate)}</span>,
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
      key: 'chevron',
      header: '',
      align: 'right',
      width: '48px',
      render: () => <Icon name="chevronRight" className="size-4 text-steel-300" />,
    },
  ];

  if (query.error !== null) {
    return <QueryFailure code={query.errorCode} message={query.error} onRetry={query.refetch} />;
  }

  return (
    <>
      <PageHeader
        title="Machines"
        breadcrumbs={[{ label: 'Machines' }]}
        description="Every machine EJE maintains, with its serial number, the customer's own machine number, its site and its service history."
      />

      <Card className="mb-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <label
              htmlFor="machine-search"
              className="mb-1.5 block text-sm font-semibold text-steel-700"
            >
              Search machines
            </label>
            <div className="relative">
              <Icon
                name="search"
                className="pointer-events-none absolute top-1/2 left-3 size-[18px] -translate-y-1/2 text-steel-400"
              />
              <input
                id="machine-search"
                type="search"
                value={term}
                onChange={(event) => setTerm(event.target.value)}
                placeholder="Model, serial number, machine number, customer or site"
                className="h-11 w-full rounded-[var(--radius-control)] border border-steel-300 bg-surface pr-3 pl-10 text-sm placeholder:text-steel-400 hover:border-steel-400 focus:border-eje-500 focus:ring-2 focus:ring-eje-100 focus:outline-none"
              />
            </div>
          </div>
          <SelectField
            label="Manufacturer"
            value={manufacturer}
            onChange={(event) => setManufacturer(event.target.value)}
            options={[
              { value: 'all', label: 'All manufacturers' },
              ...manufacturers.map((value) => ({ value, label: value })),
            ]}
          />
        </div>
      </Card>

      {query.loading ? (
        <LoadingPanel rows={5} label="Loading machines" />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          onRowClick={(row) => router.push(`/machines/${row.id}`)}
          emptyTitle="No machines found"
          emptyDescription="No machine matches the current search."
        />
      )}
    </>
  );
};

export default MachinesPage;
