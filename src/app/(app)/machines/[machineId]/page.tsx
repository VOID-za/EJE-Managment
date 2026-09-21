'use client';

import Link from 'next/link';
import { use } from 'react';
import { machineDisplayName } from '@/domain';
import {
  Badge,
  Card,
  CardHeader,
  DefinitionGrid,
  EmptyState,
  Icon,
  LoadingPanel,
  QueryFailure,
  SectionHeading,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { JobListTable } from '@/components/jobs/JobListTable';
import { reads } from '@/api/endpoints';
import { useQuery } from '@/hooks/useQuery';
import { formatDate, formatFileSize } from '@/lib/format';

const MachineDetailPage = ({
  params,
}: {
  readonly params: Promise<{ readonly machineId: string }>;
}) => {
  const { machineId } = use(params);

  const query = useQuery(`machine:${machineId}`, () => reads.machine(machineId));

  if (query.error !== null) {
    return <QueryFailure code={query.errorCode} message={query.error} onRetry={query.refetch} />;
  }
  if (query.loading) {
    return (
      <>
        <PageHeader title="Loading machine…" />
        <LoadingPanel rows={4} label="Loading machine" />
      </>
    );
  }

  const data = query.data;
  if (data === null || data === undefined) {
    return (
      <EmptyState
        title="Machine not found"
        description="This machine does not exist in the system."
        icon={<Icon name="machines" />}
      />
    );
  }

  const { machine, customer, site, jobRows } = data;
  const history = [...jobRows].sort((a, b) =>
    (b.job.scheduledDate ?? b.job.createdAt).localeCompare(a.job.scheduledDate ?? a.job.createdAt),
  );
  const lastService = history.find(
    (row) => row.job.jobType === 'service' && row.job.status === 'closed',
  );

  return (
    <>
      <PageHeader
        title={machineDisplayName(machine)}
        breadcrumbs={[
          { label: 'Machines', href: '/machines' },
          { label: machineDisplayName(machine) },
        ]}
        description={
          customer === null
            ? machine.serialNumber
            : `${customer.name} · ${site?.name ?? 'Unknown site'}`
        }
        meta={
          <div className="flex flex-wrap items-center gap-2">
            {machine.machineNumber.length > 0 && (
              <Badge tone="blue">{machine.machineNumber}</Badge>
            )}
            <Badge tone="outline">
              <span className="font-mono">{machine.serialNumber}</span>
            </Badge>
            {machine.archivedAt !== null && (
              <Badge tone="amber" dot>
                Withdrawn from the register
              </Badge>
            )}
            <Badge tone="neutral">{machine.machineType}</Badge>
            <Badge tone="neutral">{machine.controlSystem}</Badge>
            <Badge tone={machine.active ? 'green' : 'neutral'} dot>
              {machine.active ? 'In service' : 'Out of service'}
            </Badge>
          </div>
        }
        actions={
          customer !== null && (
            <Link href={`/customers/${customer.id}`}>
              <span className="inline-flex h-11 items-center gap-2 rounded-[var(--radius-control)] bg-surface px-4 text-sm font-semibold text-steel-800 ring-1 ring-steel-300 ring-inset hover:bg-steel-50">
                <Icon name="customers" className="size-4" />
                Open customer
              </span>
            </Link>
          )
        }
      />

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Machine record" />
          <DefinitionGrid
            className="mt-4"
            columns={3}
            items={[
              { label: 'Manufacturer', value: machine.manufacturer },
              { label: 'Model', value: machine.model },
              {
                label: 'Serial number',
                value: <span className="font-mono">{machine.serialNumber}</span>,
              },
              {
                label: 'Machine number',
                value: machine.machineNumber.length > 0 ? machine.machineNumber : '—',
              },
              { label: 'Machine type', value: machine.machineType },
              { label: 'Control system', value: machine.controlSystem },
              { label: 'Year of manufacture', value: String(machine.year) },
              { label: 'Installation date', value: formatDate(machine.installationDate) },
              { label: 'Customer', value: customer?.name ?? '—' },
              { label: 'Site', value: site?.name ?? '—' },
              {
                label: 'Notes',
                wide: true,
                value:
                  machine.notes.length > 0 ? (
                    machine.notes
                  ) : (
                    <span className="text-steel-400 italic">No notes recorded.</span>
                  ),
              },
            ]}
          />
        </Card>

        <div className="space-y-5">
          <Card>
            <CardHeader title="Service summary" />
            <dl className="mt-4 space-y-3 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-steel-500">Jobs on record</dt>
                <dd className="tabular font-semibold text-steel-900">{history.length}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-steel-500">Last completed service</dt>
                <dd className="tabular font-semibold text-steel-900">
                  {lastService === undefined ? '—' : formatDate(lastService.job.completedAt)}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-steel-500">Open jobs</dt>
                <dd className="tabular font-semibold text-steel-900">
                  {
                    history.filter(
                      (row) => row.job.status !== 'closed' && row.job.status !== 'submitted',
                    ).length
                  }
                </dd>
              </div>
            </dl>
          </Card>

          <Card>
            <CardHeader title="Photos" description={`${machine.photos.length} on file`} />
            {machine.photos.length === 0 ? (
              <p className="mt-4 text-sm text-steel-500">No photographs on file.</p>
            ) : (
              <ul className="mt-4 grid grid-cols-2 gap-3">
                {machine.photos.map((photo) => (
                  <li key={photo.id}>
                    <div className="flex aspect-4/3 items-center justify-center rounded-[var(--radius-control)] border border-steel-200 bg-steel-100 text-steel-400">
                      <Icon name="camera" className="size-6" />
                    </div>
                    <p className="mt-1.5 truncate text-xs font-medium text-steel-800">
                      {photo.caption}
                    </p>
                    <p className="truncate text-[11px] text-steel-400">
                      {formatFileSize(photo.sizeBytes)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <div className="mt-6">
        <SectionHeading
          title="Job history"
          description="Every job raised against this machine, most recent first."
          className="mb-3"
        />
        <JobListTable
          rows={history}
          emptyTitle="No job history"
          emptyDescription="Jobs raised against this machine will appear here."
        />
      </div>
    </>
  );
};

export default MachineDetailPage;
