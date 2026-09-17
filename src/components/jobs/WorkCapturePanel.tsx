'use client';

import { useState } from 'react';
import {
  calculateJobTotals,
  labourRateLabel,
  type Job,
  type LabourRateType,
  type SystemSettings,
  type User,
} from '@/domain';
import {
  addLabour,
  addPart,
  addTravel,
  removeLineItem,
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
  const [dialog, setDialog] = useState<'labour' | 'travel' | 'part' | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<
    { kind: LineItemKind; id: string; label: string } | null
  >(null);
  const operation = useOperation();

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
              onClick={() => setDialog('labour')}
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
                  </p>
                </div>
                <span className="tabular text-sm font-semibold text-steel-900">
                  {formatCurrency(totals.labourLines[index]?.total ?? 0)}
                </span>
                {editable && (
                  <RemoveButton
                    onClick={() =>
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

      <Card padded={false}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-steel-100 px-5 py-4">
          <CardHeader
            title="Travel"
            description={`${totals.totalKilometres.toFixed(1)} km · ${formatCurrency(totals.travelTotal)} at ${formatCurrency(settings.kilometreRate)}/km`}
          />
          {editable && (
            <Button
              size="sm"
              variant="secondary"
              leadingIcon={<Icon name="plus" className="size-4" />}
              onClick={() => setDialog('travel')}
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
                  <RemoveButton
                    onClick={() =>
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
              onClick={() => setDialog('part')}
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
                        <RemoveButton
                          onClick={() =>
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

      <LabourDialog
        open={dialog === 'labour'}
        onClose={() => setDialog(null)}
        onSubmit={async (values) => {
          const ok = await operation.run((context) => addLabour(context, job, values));
          if (ok) {
            setDialog(null);
            onChanged();
          }
        }}
        busy={operation.running}
        settings={settings}
      />

      <TravelDialog
        open={dialog === 'travel'}
        onClose={() => setDialog(null)}
        onSubmit={async (values) => {
          const ok = await operation.run((context) => addTravel(context, job, values));
          if (ok) {
            setDialog(null);
            onChanged();
          }
        }}
        busy={operation.running}
        settings={settings}
      />

      <PartDialog
        open={dialog === 'part'}
        onClose={() => setDialog(null)}
        onSubmit={async (values) => {
          const ok = await operation.run((context) => addPart(context, job, values));
          if (ok) {
            setDialog(null);
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

const RemoveButton = ({ onClick }: { readonly onClick: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label="Remove line"
    className="rounded-[var(--radius-control)] p-2 text-steel-400 transition-colors hover:bg-signal-50 hover:text-signal-600"
  >
    <Icon name="trash" className="size-4" />
  </button>
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
  settings,
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
  readonly settings: SystemSettings;
}) => {
  const [date, setDate] = useState(todayIso());
  const [rateType, setRateType] = useState<LabourRateType>('normal');
  const [hours, setHours] = useState('1');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);

  const parsedHours = Number.parseFloat(hours);
  const rate =
    rateType === 'normal'
      ? settings.labourRates.normal
      : rateType === 'overtime'
        ? settings.labourRates.overtime
        : settings.labourRates.double;

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
      title="Add labour"
      description="Hours are charged at the configured rate for the selected labour type."
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy}>
            Add labour
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
                    : 'border-steel-300 bg-white text-steel-700 hover:border-steel-400',
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
  settings,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (values: {
    date: string;
    kilometres: number;
    description: string;
  }) => void;
  readonly busy: boolean;
  readonly settings: SystemSettings;
}) => {
  const [date, setDate] = useState(todayIso());
  const [kilometres, setKilometres] = useState('');
  const [description, setDescription] = useState('');
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
      title="Add travel"
      description="Travel is charged per kilometre only."
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy}>
            Add travel
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
            hint={`${formatCurrency(settings.kilometreRate)} per km`}
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
              {formatCurrency(Math.round(parsed * settings.kilometreRate))}
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
}) => {
  const [partNumber, setPartNumber] = useState('');
  const [description, setDescription] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [unitPrice, setUnitPrice] = useState('');
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
      title="Add part"
      description="Parts fitted on this job. Prices are entered excluding VAT."
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy}>
            Add part
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
