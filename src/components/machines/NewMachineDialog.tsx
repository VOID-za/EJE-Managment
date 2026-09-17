'use client';

import { useState } from 'react';
import { can, type CustomerId, type MachineType, type Site } from '@/domain';
import { createMachine } from '@/application/machine-operations';
import {
  Button,
  Modal,
  SelectField,
  TextAreaField,
  TextField,
} from '@/components/ui';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';
import { useOperation } from '@/hooks/useOperation';
import { useCurrentUser } from '@/providers/AppProvider';

const MACHINE_TYPES: readonly MachineType[] = [
  'CNC Milling Machine',
  'CNC Lathe',
  'Machining Centre',
  'Surface Grinder',
  'Press Brake',
  'Other',
];

const todayIso = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${`${now.getMonth() + 1}`.padStart(2, '0')}-${`${now.getDate()}`.padStart(2, '0')}`;
};

/**
 * Add Machine.
 *
 * Open to technicians as well as Masters: a technician who finds an unrecorded
 * machine on site should not have to phone the office to capture work against
 * it. What differs is the outcome — a Master's addition joins the official
 * register immediately, a technician's is usable straight away but marked
 * unconfirmed until a Master approves it. The dialog says which will happen.
 */
export const NewMachineDialog = ({
  open,
  customerId,
  sites,
  onClose,
  onCreated,
}: {
  readonly open: boolean;
  readonly customerId: CustomerId;
  readonly sites: readonly Site[];
  readonly onClose: () => void;
  readonly onCreated: (machineId: string) => void;
}) => {
  const currentUser = useCurrentUser();
  const operation = useOperation();
  const goesStraightOn = can(currentUser.role, 'machines.manage');

  const [siteId, setSiteId] = useState<string>(sites[0]?.id ?? '');
  const [manufacturer, setManufacturer] = useState('');
  const [model, setModel] = useState('');
  const [serialNumber, setSerialNumber] = useState('');
  const [machineType, setMachineType] = useState<MachineType>('CNC Milling Machine');
  const [year, setYear] = useState(`${new Date().getFullYear()}`);
  const [installationDate, setInstallationDate] = useState(todayIso());
  const [controlSystem, setControlSystem] = useState('');
  const [notes, setNotes] = useState('');

  const close = (): void => {
    operation.clearError();
    onClose();
  };

  const submit = async (): Promise<void> => {
    let createdId: string | null = null;
    const ok = await operation.run(async (context) => {
      const machine = await createMachine(context, {
        customerId,
        siteId: (sites.find((site) => site.id === siteId) ?? sites[0])!.id,
        manufacturer,
        model,
        serialNumber,
        machineType,
        year: Number.parseInt(year, 10) || new Date().getFullYear(),
        installationDate,
        controlSystem,
        notes,
      });
      createdId = machine.id;
    });
    if (ok && createdId !== null) onCreated(createdId);
  };

  return (
    <Modal
      open={open}
      title="Add machine"
      description={
        goesStraightOn
          ? 'Added directly to the official register.'
          : 'Usable straight away, then confirmed onto the official register by a Master.'
      }
      onClose={close}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={operation.running}>
            Cancel
          </Button>
          <Button onClick={submit} loading={operation.running} disabled={sites.length === 0}>
            {goesStraightOn ? 'Add machine' : 'Submit for approval'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {operation.error !== null && (
          <RuleViolationNotice
            title="The machine could not be added"
            message={operation.error}
            violations={operation.violations}
          />
        )}

        {sites.length === 0 && (
          <p role="alert" className="text-sm font-medium text-signal-600">
            This customer has no site yet. Add a site before recording a machine against it.
          </p>
        )}

        {!goesStraightOn && (
          <div className="rounded-[var(--radius-control)] border border-amber-eje-200 bg-amber-eje-50 px-4 py-3 text-sm text-amber-eje-700">
            A Master will confirm this machine onto the official register. You can capture work
            against it immediately — nothing waits for the office.
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            label="Manufacturer"
            required
            value={manufacturer}
            onChange={(event) => setManufacturer(event.target.value)}
          />
          <TextField
            label="Model"
            required
            value={model}
            onChange={(event) => setModel(event.target.value)}
          />
          <TextField
            label="Serial number"
            required
            value={serialNumber}
            onChange={(event) => setSerialNumber(event.target.value)}
            hint="Identifies the machine across every job. Duplicates are refused."
            containerClassName="sm:col-span-2"
          />
          <SelectField
            label="Machine type"
            value={machineType}
            onChange={(event) => setMachineType(event.target.value as MachineType)}
            options={MACHINE_TYPES.map((type) => ({ value: type, label: type }))}
          />
          <SelectField
            label="Site"
            value={siteId}
            onChange={(event) => setSiteId(event.target.value)}
            options={sites.map((site) => ({ value: site.id, label: site.name }))}
          />
          <TextField
            label="Year"
            type="number"
            value={year}
            onChange={(event) => setYear(event.target.value)}
          />
          <TextField
            label="Installation date"
            type="date"
            value={installationDate}
            onChange={(event) => setInstallationDate(event.target.value)}
          />
          <TextField
            label="Control system"
            value={controlSystem}
            onChange={(event) => setControlSystem(event.target.value)}
            placeholder="e.g. Fanuc 0i-MF"
            containerClassName="sm:col-span-2"
          />
          <TextAreaField
            label="Notes"
            rows={3}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            hint="Non-standard parts, past repairs, anything a technician should know before arriving."
            containerClassName="sm:col-span-2"
          />
        </div>
      </div>
    </Modal>
  );
};
