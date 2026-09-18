'use client';

import { useEffect, useRef, useState } from 'react';
import {
  can,
  type CustomerId,
  type Machine,
  type MachineType,
  type Site,
} from '@/domain';
import { createMachine, updateMachine } from '@/application/machine-operations';
import { Button, Modal, SelectField, TextAreaField, TextField } from '@/components/ui';
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

interface PhotoDraft {
  readonly fileName: string;
  readonly caption: string;
}

interface Draft {
  readonly siteId: string;
  readonly manufacturer: string;
  readonly model: string;
  readonly serialNumber: string;
  readonly machineNumber: string;
  readonly machineType: MachineType;
  readonly year: string;
  readonly installationDate: string;
  readonly controlSystem: string;
  readonly notes: string;
  readonly active: boolean;
}

const emptyDraft = (sites: readonly Site[]): Draft => ({
  siteId: sites[0]?.id ?? '',
  manufacturer: '',
  model: '',
  serialNumber: '',
  machineNumber: '',
  machineType: 'CNC Milling Machine',
  year: `${new Date().getFullYear()}`,
  installationDate: todayIso(),
  controlSystem: '',
  notes: '',
  active: true,
});

const draftFrom = (machine: Machine): Draft => ({
  siteId: machine.siteId,
  manufacturer: machine.manufacturer,
  model: machine.model,
  serialNumber: machine.serialNumber,
  machineNumber: machine.machineNumber,
  machineType: machine.machineType,
  year: `${machine.year}`,
  installationDate: machine.installationDate,
  controlSystem: machine.controlSystem,
  notes: machine.notes,
  active: machine.active,
});

/**
 * Add or edit a machine.
 *
 * One dialog for both, because the fields and the rules are the same: a serial
 * number is unique either way, and an edit that duplicated one would split a
 * machine's history exactly as a bad addition would.
 *
 * Adding is open to technicians as well as the office: a technician who finds
 * an unrecorded machine on site should not have to telephone in to capture work
 * against it. What differs is the outcome — an office addition joins the
 * official register immediately, a technician's is usable straight away but
 * marked unconfirmed until it is approved. Editing the official record is the
 * office's, and the operation enforces that regardless of this dialog.
 */
export const MachineDialog = ({
  open,
  customerId,
  sites,
  machine = null,
  onClose,
  onSaved,
}: {
  readonly open: boolean;
  readonly customerId: CustomerId;
  readonly sites: readonly Site[];
  /** The machine being edited, or null to add a new one. */
  readonly machine?: Machine | null;
  readonly onClose: () => void;
  readonly onSaved: (machineId: string) => void;
}) => {
  const currentUser = useCurrentUser();
  const operation = useOperation();
  const editing = machine !== null;
  const goesStraightOn = can(currentUser.role, 'machines.manage');

  const [draft, setDraft] = useState<Draft>(() =>
    machine === null ? emptyDraft(sites) : draftFrom(machine),
  );
  const [photos, setPhotos] = useState<readonly PhotoDraft[]>([]);
  const [photoName, setPhotoName] = useState('');
  const [photoCaption, setPhotoCaption] = useState('');

  /*
   * Reload the form when the dialog is opened on a different record.
   *
   * Keyed on the machine id and the open flag ONLY. The record and the site
   * list are read through a ref rather than being listed as dependencies,
   * because a parent that rebuilds either array on every render would
   * otherwise re-run this effect on every keystroke and wipe the field being
   * typed into — the same class of bug as an effect depending on a freshly
   * created callback.
   */
  const machineId = machine?.id ?? null;
  const latest = useRef({ machine, sites });
  // Written in an effect, never during render: a ref updated mid-render is a
  // read of stale state waiting to happen.
  useEffect(() => {
    latest.current = { machine, sites };
  });

  useEffect(() => {
    if (!open) return;
    const { machine: current, sites: currentSites } = latest.current;
    setDraft(current === null ? emptyDraft(currentSites) : draftFrom(current));
    setPhotos([]);
    setPhotoName('');
    setPhotoCaption('');
  }, [open, machineId]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void =>
    setDraft((current) => ({ ...current, [key]: value }));

  const close = (): void => {
    operation.clearError();
    onClose();
  };

  const submit = async (): Promise<void> => {
    let savedId: string | null = null;
    const ok = await operation.run(async (context) => {
      const year = Number.parseInt(draft.year, 10) || new Date().getFullYear();
      if (machine !== null) {
        const saved = await updateMachine(context, {
          ...machine,
          siteId: (sites.find((site) => site.id === draft.siteId) ?? sites[0])!.id,
          manufacturer: draft.manufacturer.trim(),
          model: draft.model.trim(),
          serialNumber: draft.serialNumber.trim(),
          machineNumber: draft.machineNumber.trim(),
          machineType: draft.machineType,
          year,
          installationDate: draft.installationDate,
          controlSystem: draft.controlSystem.trim(),
          notes: draft.notes.trim(),
          active: draft.active,
        });
        savedId = saved.id;
        return;
      }

      const created = await createMachine(context, {
        customerId,
        siteId: (sites.find((site) => site.id === draft.siteId) ?? sites[0])!.id,
        manufacturer: draft.manufacturer,
        model: draft.model,
        serialNumber: draft.serialNumber,
        machineNumber: draft.machineNumber,
        machineType: draft.machineType,
        year,
        installationDate: draft.installationDate,
        controlSystem: draft.controlSystem,
        notes: draft.notes,
        photos: photos.map((photo) => ({ ...photo, sizeBytes: 1_840_000 })),
      });
      savedId = created.id;
    });
    if (ok && savedId !== null) onSaved(savedId);
  };

  return (
    <Modal
      open={open}
      title={editing ? 'Edit machine' : 'Add machine'}
      description={
        editing
          ? 'Amends the official register. Every job already recorded against this machine keeps it.'
          : goesStraightOn
            ? 'Added directly to the official register.'
            : 'Usable straight away, then confirmed onto the official register by the office.'
      }
      onClose={close}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={operation.running}>
            Cancel
          </Button>
          <Button onClick={submit} loading={operation.running} disabled={sites.length === 0}>
            {editing ? 'Save changes' : goesStraightOn ? 'Add machine' : 'Submit for approval'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {operation.error !== null && (
          <RuleViolationNotice
            title={editing ? 'The machine could not be saved' : 'The machine could not be added'}
            message={operation.error}
            violations={operation.violations}
          />
        )}

        {sites.length === 0 && (
          <p role="alert" className="text-sm font-medium text-signal-600">
            This customer has no site yet. Add a site before recording a machine against it.
          </p>
        )}

        {!editing && !goesStraightOn && (
          <div className="rounded-[var(--radius-control)] border border-amber-eje-200 bg-amber-eje-50 px-4 py-3 text-sm text-amber-eje-700">
            The office will confirm this machine onto the official register. You can capture work
            against it immediately — nothing waits for the office.
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            label="Manufacturer"
            required
            value={draft.manufacturer}
            onChange={(event) => set('manufacturer', event.target.value)}
          />
          <TextField
            label="Model"
            required
            value={draft.model}
            onChange={(event) => set('model', event.target.value)}
          />
          <TextField
            label="Serial number"
            required
            value={draft.serialNumber}
            onChange={(event) => set('serialNumber', event.target.value)}
            hint="Identifies the machine across every job. Duplicates are refused."
          />
          <TextField
            label="Machine number"
            value={draft.machineNumber}
            onChange={(event) => set('machineNumber', event.target.value)}
            placeholder="e.g. STM1"
            hint="Optional. The customer's own number for this machine, if they use one."
          />
          <SelectField
            label="Machine type"
            value={draft.machineType}
            onChange={(event) => set('machineType', event.target.value as MachineType)}
            options={MACHINE_TYPES.map((type) => ({ value: type, label: type }))}
          />
          <SelectField
            label="Site"
            value={draft.siteId}
            onChange={(event) => set('siteId', event.target.value)}
            options={sites.map((site) => ({ value: site.id, label: site.name }))}
          />
          <TextField
            label="Year"
            type="number"
            value={draft.year}
            onChange={(event) => set('year', event.target.value)}
          />
          <TextField
            label="Installation date"
            type="date"
            value={draft.installationDate}
            onChange={(event) => set('installationDate', event.target.value)}
          />
          <TextField
            label="Control system"
            value={draft.controlSystem}
            onChange={(event) => set('controlSystem', event.target.value)}
            placeholder="e.g. Fanuc 0i-MF"
            containerClassName="sm:col-span-2"
          />
          <TextAreaField
            label="Notes"
            rows={3}
            value={draft.notes}
            onChange={(event) => set('notes', event.target.value)}
            hint="Non-standard parts, past repairs, anything a technician should know before arriving."
            containerClassName="sm:col-span-2"
          />
        </div>

        {editing && (
          <label className="flex items-start gap-2.5 text-sm text-steel-700">
            <input
              type="checkbox"
              checked={draft.active}
              onChange={(event) => set('active', event.target.checked)}
              className="mt-0.5 size-4 rounded border-steel-300"
            />
            <span>
              In service
              <span className="block text-xs text-steel-500">
                Clear this for a machine that has been decommissioned but must stay on the record.
              </span>
            </span>
          </label>
        )}

        {!editing && (
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
                        setPhotos((current) => current.filter((_, position) => position !== index))
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
        )}

        <p className="rounded-[var(--radius-control)] border border-steel-200 bg-steel-50 px-3 py-2.5 text-xs text-steel-600">
          Technical documentation is not attached here. Manuals and diagrams go through the
          Technical Library, where they are versioned and approved — a machine links to them by
          manufacturer and model.
        </p>
      </div>
    </Modal>
  );
};
