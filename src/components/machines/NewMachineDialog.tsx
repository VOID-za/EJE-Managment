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
  const [photos, setPhotos] = useState<readonly { fileName: string; caption: string }[]>([]);
  const [photoName, setPhotoName] = useState('');
  const [photoCaption, setPhotoCaption] = useState('');

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
        photos: photos.map((photo) => ({ ...photo, sizeBytes: 1_840_000 })),
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

        <div className="border-t border-steel-100 pt-4">
          <p className="text-sm font-semibold text-steel-700">Photographs</p>
          <p className="mt-0.5 text-xs text-steel-500">
            The machine as found — rating plate, control cabinet, anything that identifies it.{' '}
            <span className="font-medium">
              Demo mode: no file is transferred. The record is created exactly as the production
              uploader will create it.
            </span>
          </p>

          {photos.length > 0 && (
            <ul className="mt-3 divide-y divide-steel-100 rounded-[var(--radius-control)] border border-steel-200">
              {photos.map((photo, index) => (
                <li
                  key={`${photo.fileName}-${index}`}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-xs text-steel-800">
                      {photo.fileName}
                    </span>
                    {photo.caption.length > 0 && (
                      <span className="block truncate text-xs text-steel-500">
                        {photo.caption}
                      </span>
                    )}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setPhotos((current) =>
                        current.filter((_, position) => position !== index),
                      )
                    }
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-3 flex flex-wrap items-end gap-3">
            <TextField
              label="File name"
              value={photoName}
              onChange={(event) => setPhotoName(event.target.value)}
              placeholder="mazak-qt200-rating-plate.jpg"
              containerClassName="min-w-[14rem] flex-1"
            />
            <TextField
              label="Caption"
              value={photoCaption}
              onChange={(event) => setPhotoCaption(event.target.value)}
              placeholder="Rating plate"
              containerClassName="min-w-[10rem] flex-1"
            />
            <Button
              variant="secondary"
              disabled={photoName.trim().length === 0}
              onClick={() => {
                setPhotos((current) => [
                  ...current,
                  { fileName: photoName.trim(), caption: photoCaption.trim() },
                ]);
                setPhotoName('');
                setPhotoCaption('');
              }}
            >
              Add photograph
            </Button>
          </div>
        </div>

        <p className="rounded-[var(--radius-control)] border border-steel-200 bg-steel-50 px-3 py-2.5 text-xs text-steel-600">
          Technical documentation is not attached here. Manuals and diagrams go through the
          Technical Library, where they are versioned and approved — a machine links to them by
          manufacturer and model.
        </p>
      </div>
    </Modal>
  );
};
