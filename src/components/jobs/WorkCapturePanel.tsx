'use client';

import { useState } from 'react';
import {
  calculateJobTotals,
  getJobTypeDefinition,
  labourRateFor,
  labourRateLabel,
  type Job,
  type LabourEntry,
  type LabourRateType,
  type PartEntry,
  type TravelEntry,
  type PricingInputs,
  type SystemSettings,
  type User,
} from '@/domain';
import {
  addLabour,
  addPart,
  addTravel,
  removeLineItem,
  setCalloutApplied,
  updateLabour,
  updatePart,
  updateTravel,
  type LineItemKind,
} from '@/application/job-operations';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  Icon,
  Modal,
  SelectField,
  TextAreaField,
  TextField,
} from '@/components/ui';
import { formatCurrency, formatDate } from '@/lib/format';
import { useOperation } from '@/hooks/useOperation';
import { cn } from '@/lib/cn';

/**
 * Labour, travel and parts capture.
 *
 * Costing shown next to each line is computed by the domain pricing module, not
 * by the component, so what the technician sees is what the invoice will say.
 */

export interface WorkCapturePanelProps {
  readonly job: Job;
  readonly settings: SystemSettings;
  readonly users: readonly User[];
  readonly editable: boolean;
  readonly onChanged: () => void;
}

const todayIso = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${`${now.getMonth() + 1}`.padStart(2, '0')}-${`${now.getDate()}`.padStart(2, '0')}`;
};

export const WorkCapturePanel = ({
  job,
  settings,
  users,
  editable,
  onChanged,
}: WorkCapturePanelProps) => {
  const totals = calculateJobTotals(job, settings);
  // A parts collection has no site visit, so hours, distance and a call-out fee
  // do not apply. Driven by the job type definition rather than a code check.
  const capturesLabourAndTravel = getJobTypeDefinition(job.jobType).capturesLabourAndTravel;
  const [dialog, setDialog] = useState<'labour' | 'travel' | 'part' | null>(null);
  // When set, the dialog is amending this line rather than adding a new one.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<
    { kind: LineItemKind; id: string; label: string } | null
  >(null);
  const operation = useOperation();

  const closeDialog = () => {
    setDialog(null);
    setEditingId(null);
  };

  const technicianName = (id: string): string => {
    const user = users.find((candidate) => candidate.id === id);
    return user === undefined ? 'Unknown' : `${user.firstName} ${user.lastName}`;
  };

  const confirmRemoval = async () => {
    if (pendingRemoval === null) return;
    const ok = await operation.run((context) =>
      removeLineItem(context, job, pendingRemoval.kind, pendingRemoval.id),
    );
    setPendingRemoval(null);
    if (ok) onChanged();
  };

  return (
    <div className="space-y-5">
      {operation.error !== null && (
        <p role="alert" className="text-sm font-medium text-signal-600">
          {operation.error}
        </p>
      )}

      {!capturesLabourAndTravel && (
        <div className="rounded-[var(--radius-control)] border border-amber-eje-200 bg-amber-eje-50 px-4 py-3 text-sm text-amber-eje-700">
          A parts collection records goods handed over, so it carries no labour, travel or
          call-out fee — only the parts below.
        </div>
      )}

      {capturesLabourAndTravel && (
      <>
      <Card padded={false}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-steel-100 px-5 py-4">
          <CardHeader
            title="Labour"
            description={`${totals.totalHours.toFixed(2)} hours · ${formatCurrency(totals.labourTotal)}`}
          />
          {editable && (
            <Button
              size="sm"
              variant="secondary"
              leadingIcon={<Icon name="plus" className="size-4" />}
              onClick={() => {
                setEditingId(null);
                setDialog('labour');
              }}
            >
              Add labour
            </Button>
          )}
        </div>

        {job.labour.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title="No labour captured"
              description="Add the hours worked on this job, split by normal, overtime and double time."
            />
          </div>
        ) : (
          <ul className="divide-y divide-steel-100">
            {job.labour.map((entry, index) => (
              <li key={entry.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      tone={
                        entry.rateType === 'normal'
                          ? 'neutral'
                          : entry.rateType === 'overtime'
                            ? 'amber'
                            : 'red'
                      }
                      size="sm"
                    >
                      {labourRateLabel(entry.rateType)}
                    </Badge>
                    <span className="tabular text-sm font-semibold text-steel-900">
                      {entry.hours.toFixed(2)} hrs
                    </span>
                    <span className="text-xs text-steel-400">{formatDate(entry.date)}</span>
                  </div>
                  <p className="mt-1 text-sm text-steel-600">
                    {entry.description.length > 0 ? entry.description : 'No description'}
                  </p>
                  <p className="mt-0.5 text-xs text-steel-400">
                    {technicianName(entry.technicianId)}
                    {/* Said out loud when the office wrote it up for them, so
                        nobody has to guess whose hours these are. */}
                    {entry.capturedBy !== entry.technicianId && (
                      <> · captured by {technicianName(entry.capturedBy)}</>
                    )}
                  </p>
                </div>
                <span className="tabular text-sm font-semibold text-steel-900">
                  {formatCurrency(totals.labourLines[index]?.total ?? 0)}
                </span>
                {editable && (
                  <LineActions
                    onEdit={() => {
                      setEditingId(entry.id);
                      setDialog('labour');
                    }}
                    onRemove={() =>
                      setPendingRemoval({
                        kind: 'labour',
                        id: entry.id,
                        label: `${entry.hours.toFixed(2)} hrs — ${labourRateLabel(entry.rateType)}`,
                      })
                    }
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <CardHeader
            title="Call-out fee"
            description={
              job.calloutApplied
                ? `Applied — ${formatCurrency(totals.pricing.calloutRate)}`
                : 'Not applied to this job'
            }
          />
          <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm font-medium text-steel-700">
            <input
              type="checkbox"
              checked={job.calloutApplied}
              disabled={!editable || operation.running}
              onChange={async (event) => {
                const ok = await operation.run((context) =>
                  setCalloutApplied(context, job, event.target.checked),
                );
                if (ok) onChanged();
              }}
              className="size-4.5 rounded border-steel-300 text-eje-600 focus:ring-eje-500"
            />
            Charge the call-out fee
          </label>
        </div>
        <p className="mt-2 text-xs text-steel-500">
          Whether a call-out is charged is a commercial decision per job, so it is set here rather
          than assumed from the job type.
        </p>
      </Card>

      <Card padded={false}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-steel-100 px-5 py-4">
          <CardHeader
            title="Travel"
            description={`${totals.totalKilometres.toFixed(1)} km · ${formatCurrency(totals.travelTotal)} at ${formatCurrency(totals.pricing.kilometreRate)}/km`}
          />
          {editable && (
            <Button
              size="sm"
              variant="secondary"
              leadingIcon={<Icon name="plus" className="size-4" />}
              onClick={() => {
                setEditingId(null);
                setDialog('travel');
              }}
            >
              Add travel
            </Button>
          )}
        </div>

        {job.travel.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title="No travel captured"
              description="Travel is charged per kilometre. Capture the distance for each trip."
            />
          </div>
        ) : (
          <ul className="divide-y divide-steel-100">
            {job.travel.map((entry, index) => (
              <li key={entry.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                <span className="flex size-9 items-center justify-center rounded-full bg-steel-100 text-steel-500">
                  <Icon name="truck" className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="tabular text-sm font-semibold text-steel-900">
                    {entry.kilometres.toFixed(1)} km
                    <span className="ml-2 text-xs font-normal text-steel-400">
                      {formatDate(entry.date)}
                    </span>
                  </p>
                  <p className="mt-0.5 text-sm text-steel-600">
                    {entry.description.length > 0 ? entry.description : 'No description'}
                  </p>
                </div>
                <span className="tabular text-sm font-semibold text-steel-900">
                  {formatCurrency(totals.travelLines[index]?.total ?? 0)}
                </span>
                {editable && (
                  <LineActions
                    onEdit={() => {
                      setEditingId(entry.id);
                      setDialog('travel');
                    }}
                    onRemove={() =>
                      setPendingRemoval({
                        kind: 'travel',
                        id: entry.id,
                        label: `${entry.kilometres.toFixed(1)} km`,
                      })
                    }
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      </>
      )}

      <Card padded={false}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-steel-100 px-5 py-4">
          <CardHeader
            title="Parts"
            description={`${job.parts.length} ${job.parts.length === 1 ? 'line' : 'lines'} · ${formatCurrency(totals.partsTotal)}`}
          />
          {editable && (
            <Button
              size="sm"
              variant="secondary"
              leadingIcon={<Icon name="plus" className="size-4" />}
              onClick={() => {
                setEditingId(null);
                setDialog('part');
              }}
            >
              Add part
            </Button>
          )}
        </div>

        {job.parts.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title="No parts used"
              description="Capture every part fitted, with its part number, quantity and unit price."
            />
          </div>
        ) : (
          <div className="eje-scrollbar overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-steel-100 bg-steel-50 text-xs tracking-wide text-steel-500 uppercase">
                  <th className="px-5 py-2.5 text-left font-semibold">Part number</th>
                  <th className="px-3 py-2.5 text-left font-semibold">Description</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Qty</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Unit</th>
                  <th className="px-5 py-2.5 text-right font-semibold">Total</th>
                  {editable && <th className="w-12" />}
                </tr>
              </thead>
              <tbody>
                {job.parts.map((entry, index) => (
                  <tr key={entry.id} className="border-b border-steel-100 last:border-b-0">
                    <td className="px-5 py-3 font-mono text-sm font-medium text-steel-900">
                      {entry.partNumber}
                    </td>
                    <td className="px-3 py-3 text-steel-600">{entry.description}</td>
                    <td className="tabular px-3 py-3 text-right text-steel-800">
                      {entry.quantity}
                    </td>
                    <td className="tabular px-3 py-3 text-right text-steel-600">
                      {formatCurrency(entry.unitPrice)}
                    </td>
                    <td className="tabular px-5 py-3 text-right font-semibold text-steel-900">
                      {formatCurrency(totals.partLines[index]?.total ?? 0)}
                    </td>
                    {editable && (
                      <td className="pr-3">
                        <LineActions
                          onEdit={() => {
                            setEditingId(entry.id);
                            setDialog('part');
                          }}
                          onRemove={() =>
                            setPendingRemoval({
                              kind: 'part',
                              id: entry.id,
                              label: `${entry.partNumber} — ${entry.description}`,
                            })
                          }
                        />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/*
        One dialog per kind, used for BOTH adding and amending. `editingId`
        decides which, so the technician always sees the same form and an
        amendment cannot drift away from the shape of the original entry.
      */}
      <LabourDialog
        key={`labour-${editingId ?? 'new'}`}
        open={dialog === 'labour'}
        existing={job.labour.find((entry) => entry.id === editingId) ?? null}
        onClose={closeDialog}
        onSubmit={async (values) => {
          const ok = await operation.run((context) =>
            editingId === null
              ? addLabour(context, job, values)
              : updateLabour(context, job, editingId, values),
          );
          if (ok) {
            closeDialog();
            onChanged();
          }
        }}
        busy={operation.running}
        pricing={totals.pricing}
      />

      <TravelDialog
        key={`travel-${editingId ?? 'new'}`}
        open={dialog === 'travel'}
        existing={job.travel.find((entry) => entry.id === editingId) ?? null}
        onClose={closeDialog}
        onSubmit={async (values) => {
          const ok = await operation.run((context) =>
            editingId === null
              ? addTravel(context, job, values)
              : updateTravel(context, job, editingId, values),
          );
          if (ok) {
            closeDialog();
            onChanged();
          }
        }}
        busy={operation.running}
        pricing={totals.pricing}
      />

      <PartDialog
        key={`part-${editingId ?? 'new'}`}
        open={dialog === 'part'}
        existing={job.parts.find((entry) => entry.id === editingId) ?? null}
        onClose={closeDialog}
        onSubmit={async (values) => {
          const ok = await operation.run((context) =>
            editingId === null
              ? addPart(context, job, values)
              : updatePart(context, job, editingId, values),
          );
          if (ok) {
            closeDialog();
            onChanged();
          }
        }}
        busy={operation.running}
      />

      <ConfirmDialog
        open={pendingRemoval !== null}
        title="Remove this line?"
        message={
          <>
            <p>
              <span className="font-semibold">{pendingRemoval?.label}</span> will be removed from{' '}
              {job.jobNumber}.
            </p>
            <p className="mt-2 text-steel-500">
              This cannot be undone. The removal is recorded against the job.
            </p>
          </>
        }
        confirmLabel="Remove line"
        confirmVariant="danger"
        busy={operation.running}
        onConfirm={confirmRemoval}
        onCancel={() => setPendingRemoval(null)}
      />
    </div>
  );
};

const LineActions = ({
  onEdit,
  onRemove,
}: {
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}) => (
  <span className="flex items-center gap-0.5">
    <button
      type="button"
      onClick={onEdit}
      aria-label="Edit line"
      title="Edit line"
      className="rounded-[var(--radius-control)] p-2 text-steel-400 transition-colors hover:bg-eje-50 hover:text-eje-700"
    >
      <Icon name="wrench" className="size-4" />
    </button>
    <button
      type="button"
      onClick={onRemove}
      aria-label="Remove line"
      title="Remove line"
      className="rounded-[var(--radius-control)] p-2 text-steel-400 transition-colors hover:bg-signal-50 hover:text-signal-600"
    >
      <Icon name="trash" className="size-4" />
    </button>
  </span>
);

const RATE_OPTIONS: readonly { value: LabourRateType; label: string }[] = [
  { value: 'normal', label: 'Normal Time' },
  { value: 'overtime', label: 'Overtime' },
  { value: 'double', label: 'Double Time' },
];

/** Quick-pick hour buttons keep the technician off the keyboard. */
const HOUR_PRESETS = [0.5, 1, 1.5, 2, 3, 4, 6, 8] as const;

const LabourDialog = ({
  open,
  onClose,
  onSubmit,
  busy,
  pricing,
  existing,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (values: {
    date: string;
    rateType: LabourRateType;
    hours: number;
    description: string;
  }) => void;
  readonly busy: boolean;
  readonly pricing: PricingInputs;
  readonly existing: LabourEntry | null;
}) => {
  const [date, setDate] = useState(existing?.date ?? todayIso());
  const [rateType, setRateType] = useState<LabourRateType>(existing?.rateType ?? 'normal');
  const [hours, setHours] = useState(existing === null ? '1' : String(existing.hours));
  const [description, setDescription] = useState(existing?.description ?? '');
  const [error, setError] = useState<string | undefined>(undefined);

  const parsedHours = Number.parseFloat(hours);
  const rate = labourRateFor(pricing, rateType);

  const submit = () => {
    if (!Number.isFinite(parsedHours) || parsedHours <= 0) {
      setError('Enter the number of hours worked.');
      return;
    }
    setError(undefined);
    onSubmit({ date, rateType, hours: parsedHours, description: description.trim() });
  };

  return (
    <Modal
      open={open}
      title={existing === null ? 'Add labour' : 'Edit labour'}
      description="Hours are charged at the rate that applies to this job."
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy}>
            {existing === null ? 'Add labour' : 'Save changes'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            label="Date"
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
          <SelectField
            label="Labour type"
            value={rateType}
            onChange={(event) => setRateType(event.target.value as LabourRateType)}
            options={RATE_OPTIONS.map((option) => ({
              value: option.value,
              label: option.label,
            }))}
            hint={`${formatCurrency(rate)} per hour`}
          />
        </div>

        <div>
          <p className="mb-2 text-sm font-semibold text-steel-700">Hours</p>
          <div className="grid grid-cols-4 gap-2">
            {HOUR_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setHours(String(preset))}
                className={cn(
                  'tabular h-12 rounded-[var(--radius-control)] border text-sm font-semibold transition-colors',
                  hours === String(preset)
                    ? 'border-eje-500 bg-eje-50 text-eje-700'
                    : 'border-steel-300 bg-surface text-steel-700 hover:border-steel-400',
                )}
              >
                {preset}
              </button>
            ))}
          </div>
          <TextField
            label="Or enter hours"
            type="number"
            min="0"
            step="0.25"
            inputMode="decimal"
            value={hours}
            onChange={(event) => setHours(event.target.value)}
            error={error}
            containerClassName="mt-3"
          />
        </div>

        <TextAreaField
          label="Description of work"
          rows={3}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="e.g. Fault finding on the spindle drive and control cabinet"
        />

        {Number.isFinite(parsedHours) && parsedHours > 0 && (
          <p className="rounded-[var(--radius-control)] bg-steel-50 px-3 py-2.5 text-sm text-steel-600">
            Line total:{' '}
            <span className="tabular font-semibold text-steel-900">
              {formatCurrency(Math.round(parsedHours * rate))}
            </span>
          </p>
        )}
      </div>
    </Modal>
  );
};

const TravelDialog = ({
  open,
  onClose,
  onSubmit,
  busy,
  pricing,
  existing,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (values: {
    date: string;
    kilometres: number;
    description: string;
  }) => void;
  readonly busy: boolean;
  readonly pricing: PricingInputs;
  readonly existing: TravelEntry | null;
}) => {
  const [date, setDate] = useState(existing?.date ?? todayIso());
  const [kilometres, setKilometres] = useState(
    existing === null ? '' : String(existing.kilometres),
  );
  const [description, setDescription] = useState(existing?.description ?? '');
  const [error, setError] = useState<string | undefined>(undefined);

  const parsed = Number.parseFloat(kilometres);

  const submit = () => {
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError('Enter the distance travelled in kilometres.');
      return;
    }
    setError(undefined);
    onSubmit({ date, kilometres: parsed, description: description.trim() });
  };

  return (
    <Modal
      open={open}
      title={existing === null ? 'Add travel' : 'Edit travel'}
      description="Travel is charged per kilometre only."
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy}>
            {existing === null ? 'Add travel' : 'Save changes'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            label="Date"
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
          <TextField
            label="Kilometres"
            type="number"
            min="0"
            step="1"
            inputMode="decimal"
            value={kilometres}
            onChange={(event) => setKilometres(event.target.value)}
            error={error}
            hint={`${formatCurrency(pricing.kilometreRate)} per km`}
            placeholder="e.g. 48"
          />
        </div>

        <TextAreaField
          label="Description"
          rows={2}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="e.g. Isando to Germiston and return"
        />

        {Number.isFinite(parsed) && parsed > 0 && (
          <p className="rounded-[var(--radius-control)] bg-steel-50 px-3 py-2.5 text-sm text-steel-600">
            Line total:{' '}
            <span className="tabular font-semibold text-steel-900">
              {formatCurrency(Math.round(parsed * pricing.kilometreRate))}
            </span>
          </p>
        )}
      </div>
    </Modal>
  );
};

const PartDialog = ({
  open,
  onClose,
  onSubmit,
  busy,
  existing,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (values: {
    partNumber: string;
    description: string;
    quantity: number;
    unitPrice: number;
  }) => void;
  readonly busy: boolean;
  readonly existing: PartEntry | null;
}) => {
  const [partNumber, setPartNumber] = useState(existing?.partNumber ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [quantity, setQuantity] = useState(existing === null ? '1' : String(existing.quantity));
  const [unitPrice, setUnitPrice] = useState(
    existing === null ? '' : (existing.unitPrice / 100).toFixed(2),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  const parsedQuantity = Number.parseInt(quantity, 10);
  const parsedPrice = Number.parseFloat(unitPrice);

  const submit = () => {
    const next: Record<string, string> = {};
    if (partNumber.trim().length === 0) next.partNumber = 'A part number is required.';
    if (description.trim().length === 0) next.description = 'A description is required.';
    if (!Number.isFinite(parsedQuantity) || parsedQuantity <= 0) next.quantity = 'Enter a quantity.';
    if (!Number.isFinite(parsedPrice) || parsedPrice < 0) next.unitPrice = 'Enter a unit price.';

    setErrors(next);
    if (Object.keys(next).length > 0) return;

    onSubmit({
      partNumber: partNumber.trim(),
      description: description.trim(),
      quantity: parsedQuantity,
      // Prices are entered in rands and stored in cents.
      unitPrice: Math.round(parsedPrice * 100),
    });
  };

  return (
    <Modal
      open={open}
      title={existing === null ? 'Add part' : 'Edit part'}
      description="Parts fitted on this job. Prices are entered excluding VAT."
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy}>
            {existing === null ? 'Add part' : 'Save changes'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <TextField
          label="Part number"
          value={partNumber}
          onChange={(event) => setPartNumber(event.target.value)}
          error={errors.partNumber}
          placeholder="e.g. FLT-CAB-220"
          required
        />
        <TextField
          label="Description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          error={errors.description}
          placeholder="e.g. Electrical cabinet filter mat"
          required
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            label="Quantity"
            type="number"
            min="1"
            step="1"
            inputMode="numeric"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            error={errors.quantity}
            required
          />
          <TextField
            label="Unit price (excl. VAT)"
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            value={unitPrice}
            onChange={(event) => setUnitPrice(event.target.value)}
            error={errors.unitPrice}
            placeholder="0.00"
            required
          />
        </div>

        {Number.isFinite(parsedQuantity) && Number.isFinite(parsedPrice) && parsedPrice >= 0 && (
          <p className="rounded-[var(--radius-control)] bg-steel-50 px-3 py-2.5 text-sm text-steel-600">
            Line total:{' '}
            <span className="tabular font-semibold text-steel-900">
              {formatCurrency(Math.round(parsedQuantity * parsedPrice * 100))}
            </span>
          </p>
        )}
      </div>
    </Modal>
  );
};
