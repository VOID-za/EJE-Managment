'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  can,
  isMachineConfirmed,
  machineDisplayName,
  userFullName,
  type Customer,
  type Machine,
  type Site,
  type User,
} from '@/domain';
import type { JobListRow } from '@/application/job-view';
import { approveMachine, removeMachine } from '@/application/machine-operations';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  DefinitionGrid,
  EmptyState,
  Icon,
} from '@/components/ui';
import { MachineDialog } from '@/components/machines/MachineDialog';
import { useOperation } from '@/hooks/useOperation';
import { useCurrentUser } from '@/providers/AppProvider';
import { formatDate, formatRelative } from '@/lib/format';

/**
 * The customer's machines.
 *
 * Every job hangs off a machine, so this is the register the office works from:
 * add one, correct one, confirm the one a technician found on site, and remove
 * the one that should never have been here.
 */
export const CustomerMachinesTab = ({
  customer,
  sites,
  machines,
  jobRows,
  users,
  onChanged,
}: {
  readonly customer: Customer;
  readonly sites: readonly Site[];
  readonly machines: readonly Machine[];
  readonly jobRows: readonly JobListRow[];
  readonly users: readonly User[];
  readonly onChanged: () => void;
}) => {
  const currentUser = useCurrentUser();
  const operation = useOperation();
  const canManage = can(currentUser.role, 'machines.manage');

  const [dialog, setDialog] = useState<{ open: boolean; machine: Machine | null }>({
    open: false,
    machine: null,
  });
  const [pending, setPending] = useState<Machine | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  const unconfirmed = machines.filter((machine) => !isMachineConfirmed(machine));

  const confirmRemoval = async (): Promise<void> => {
    if (pending === null) return;
    const result = await operation.runFor((context) => removeMachine(context, pending));
    if (result === null) return;
    setPending(null);
    setOutcome(result.message);
    onChanged();
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-steel-500">
          Machines are reached through the customer and their sites. Every job and its history
          hangs off the machine.
        </p>
        <Button
          variant="secondary"
          leadingIcon={<Icon name="plus" className="size-4" />}
          onClick={() => setDialog({ open: true, machine: null })}
        >
          Add machine
        </Button>
      </div>

      {operation.error !== null && (
        <p role="alert" className="mb-4 text-sm font-medium text-signal-600">
          {operation.error}
        </p>
      )}
      {outcome !== null && (
        <div
          role="status"
          className="mb-4 flex items-start justify-between gap-3 rounded-[var(--radius-control)] border border-steel-200 bg-steel-50 px-4 py-3 text-sm text-steel-700"
        >
          <span>{outcome}</span>
          <Button size="sm" variant="ghost" onClick={() => setOutcome(null)}>
            Dismiss
          </Button>
        </div>
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
              <Card key={machine.id} className="flex h-full flex-col">
                {/* The link wraps only the identity, not the whole card, so the
                    Edit and Remove buttons are not anchors inside an anchor. */}
                <Link href={`/machines/${machine.id}`} className="group block">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-base font-semibold text-steel-900 group-hover:text-eje-700">
                        {machineDisplayName(machine)}
                      </p>
                      <p className="truncate font-mono text-xs text-steel-500">
                        {machine.serialNumber}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {machine.machineNumber.length > 0 && (
                        <Badge tone="blue" size="sm">
                          {machine.machineNumber}
                        </Badge>
                      )}
                      <Badge tone="outline" size="sm">
                        {machine.year}
                      </Badge>
                      {!isMachineConfirmed(machine) && (
                        <Badge tone="amber" size="sm" dot>
                          Awaiting approval
                        </Badge>
                      )}
                      {!machine.active && (
                        <Badge tone="neutral" size="sm">
                          Out of service
                        </Badge>
                      )}
                    </div>
                  </div>
                </Link>
                <DefinitionGrid
                  className="mt-4"
                  columns={1}
                  items={[
                    { label: 'Machine number', value: machine.machineNumber || '—' },
                    { label: 'Type', value: machine.machineType },
                    { label: 'Site', value: site?.name ?? '—' },
                    { label: 'Control', value: machine.controlSystem },
                    { label: 'Installed', value: formatDate(machine.installationDate) },
                  ]}
                />
                <div className="mt-auto flex items-center justify-between gap-2 border-t border-steel-100 pt-3">
                  <p className="text-xs text-steel-500">
                    {machineJobs.length} {machineJobs.length === 1 ? 'job' : 'jobs'} on record
                  </p>
                  {canManage && (
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setDialog({ open: true, machine })}
                      >
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setPending(machine)}>
                        Remove
                      </Button>
                    </div>
                  )}
                </div>
              </Card>
            );
          })
        )}
      </div>

      {canManage && unconfirmed.length > 0 && (
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
                      const author = users.find((candidate) => candidate.id === machine.createdBy);
                      return author === undefined ? 'a technician' : userFullName(author);
                    })()}{' '}
                    · {formatRelative(machine.createdAt)}
                  </p>
                </div>
                <Button
                  size="sm"
                  loading={operation.running}
                  onClick={async () => {
                    const ok = await operation.run((context) => approveMachine(context, machine));
                    if (ok) onChanged();
                  }}
                >
                  Confirm on register
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <MachineDialog
        open={dialog.open}
        customerId={customer.id}
        sites={sites}
        machine={dialog.machine}
        onClose={() => setDialog({ open: false, machine: null })}
        onSaved={() => {
          setDialog({ open: false, machine: null });
          onChanged();
        }}
      />

      <ConfirmDialog
        open={pending !== null}
        title="Remove this machine?"
        confirmLabel="Remove"
        confirmVariant="danger"
        busy={operation.running}
        onCancel={() => {
          operation.clearError();
          setPending(null);
        }}
        onConfirm={confirmRemoval}
        message={
          pending === null ? null : (
            <>
              <p>
                <strong>{machineDisplayName(pending)}</strong> (serial {pending.serialNumber}) will
                be taken off the register.
              </p>
              <p className="mt-2">
                If any job has ever been carried out on it, the machine is kept and simply withdrawn
                from the register, so that job history still reads correctly. If not, it is deleted.
                You will be told which happened.
              </p>
            </>
          )
        }
      />
    </>
  );
};
