'use client';

import { useState } from 'react';
import {
  calculateJobTotals,
  getJobTypeDefinition,
  labourRateFor,
  labourRateLabel,
  partsLockedAfterCompletion,
  type Job,
  type LabourEntry,
  type LabourRateType,
  type AdditionalChargeEntry,
  type PartEntry,
  type TravelEntry,
  type PricingInputs,
  type SystemSettings,
  type User,
} from '@/domain';
import type { LineItemKind } from '@/application/job-operations';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  Icon,
  Modal,
  SelectField,
  TextAreaField,
  TextField,
} from '@/components/ui';
import { formatCurrency, formatDate } from '@/lib/format';
import { jobs } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';
import { useOfflineCapture } from '@/hooks/useOfflineCapture';
import { cn } from '@/lib/cn';
import { businessToday } from '@/lib/business-time';

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

export const WorkCapturePanel = ({
  job,
  settings,
  users,
  editable,
  onChanged,
}: WorkCapturePanelProps) => {
  // TR-01: parts on a completed job are fixed (Parts jobs excepted); the rule is the server's too.
  const partsLocked = partsLockedAfterCompletion(job);
  const partsEditable = editable && !partsLocked;
  const totals = calculateJobTotals(job, settings);
  // A parts collection has no site visit, so hours, distance and a call-out fee
  // do not apply. Driven by the job type definition rather than a code check.
  const capturesLabourAndTravel = getJobTypeDefinition(job.jobType).capturesLabourAndTravel;
  const [dialog, setDialog] = useState<
    'labour' | 'travel' | 'part' | 'additional_charge' | null
  >(null);
  // When set, the dialog is amending this line rather than adding a new one.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<
    { kind: LineItemKind; id: string; label: string } | null
  >(null);
  const operation = useOperation();
  /*
   * ADDING A LINE GOES THROUGH HERE, not through `operation`. OFF-2.
   *
   * It tries the server first and holds the capture on the tablet only when
   * there is no connection — and says which of the two happened. AMENDING and
   * REMOVING a line still go through `operation` and still need a connection,
   * because both replace or delete something on the server and a queue cannot
   * decide what happens if it changed in the meantime (OFF-9).
   */
  const capture = useOfflineCapture(job);
  const [held, setHeld] = useState<string | null>(null);

  /*
   * EVERY DIALOG OPENS FRESH. PARTS-MULTI-1, 27 October 2026.
   *
   * The dialogs were keyed `part-new`, `labour-new`, … so React kept the
   * same component between one *Add* and the next: the second *Add part*
   * opened holding the first part's number, description and price, which read
   * as editing the part already on the job — the reason staff reported that
   * only one part could be added. The nonce moves on every close, so each
   * opening is a new form.
   */
  const [dialogNonce, setDialogNonce] = useState(0);
  const closeDialog = () => {
    // A refusal belongs to the dialog it happened in, not the next one.
    capture.clear();
    setDialog(null);
    setEditingId(null);
    setDialogNonce((value) => value + 1);
  };

  const technicianName = (id: string): string => {
    const user = users.find((candidate) => candidate.id === id);
    return user === undefined ? 'Unknown' : `${user.firstName} ${user.lastName}`;
  };

  const confirmRemoval = async () => {
    if (pendingRemoval === null) return;
    const ok = await operation.run(() =>
      jobs.removeLine(job.id, pendingRemoval.kind, pendingRemoval.id),
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

      {capture.outcome?.kind === 'refused' && (
        <p role="alert" className="text-sm font-medium text-signal-600">
          {capture.outcome.message}
        </p>
      )}

      {/*
        SAVED ON THIS TABLET IS NOT SAVED ON THE SERVER, and this line is the
        difference. It names what was held and says plainly that it is not on
        the job yet — the technician decides when to send it, and the queue
        below the job sends it by itself when the signal returns.
      */}
      {held !== null && (
        <p
          role="status"
          data-testid="capture-held"
          className="rounded-[var(--radius-control)] border border-amber-eje-200 bg-amber-eje-50 px-3.5 py-2.5 text-sm font-medium text-amber-eje-800"
        >
          Held on this tablet: {held}. It is <strong>not on the server yet</strong> — see
          &ldquo;Work waiting to be sent&rdquo; on this job.
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

        {job.labour.length === 0 ? null : (
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
                  {/* Only where a line actually carries one — which now means
                      lines captured before the description was dropped. An
                      empty "No description" under every entry is noise. */}
                  {entry.description.length > 0 && (
                    <p className="mt-1 text-sm text-steel-600">{entry.description}</p>
                  )}
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

        {job.travel.length === 0 ? null : (
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
          {partsEditable && (
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

        {editable && partsLocked && (
          <p className="border-b border-steel-100 px-5 py-3 text-sm text-steel-600" data-testid="parts-locked-notice">
            This job has been completed, so its parts can no longer be changed. To change a part, cancel
            completion — the job returns to In Progress with everything kept.
          </p>
        )}

        {job.parts.length === 0 ? null : (
          <div className="eje-scrollbar overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-steel-100 bg-steel-50 text-xs tracking-wide text-steel-500 uppercase">
                  <th className="px-5 py-2.5 text-left font-semibold">Part number</th>
                  <th className="px-3 py-2.5 text-left font-semibold">Description</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Qty</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Unit</th>
                  <th className="px-5 py-2.5 text-right font-semibold">Total</th>
                  {partsEditable && <th className="w-12" />}
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
                    {partsEditable && (
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
        ADDITIONAL CHARGES. COST-5.

        Everything that is money on the job but is not labour, travel or a
        part: consumables, a workshop bench fee, a sub-contractor's invoice
        passed through, the courier on a part that had to be flown in. Until
        this existed the office put them on a PART line with an invented part
        number, which is how a parts search starts returning things that are
        not parts.

        No quantity and no unit price, because a sum of money with a reason
        beside it has neither — see `AdditionalChargeEntry`.
      */}
      <Card padded={false}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-steel-100 px-5 py-4">
          <CardHeader
            title="Additional charges"
            description={
              job.additionalCharges.length === 0
                ? 'Consumables, bench fees, anything that is not labour, travel or a part'
                : `${job.additionalCharges.length} ${
                    job.additionalCharges.length === 1 ? 'line' : 'lines'
                  } · ${formatCurrency(totals.additionalChargesTotal)}`
            }
          />
          {editable && (
            <Button
              size="sm"
              variant="secondary"
              leadingIcon={<Icon name="plus" className="size-4" />}
              onClick={() => {
                setEditingId(null);
                setDialog('additional_charge');
              }}
            >
              Add charge
            </Button>
          )}
        </div>

        {job.additionalCharges.length === 0 ? null : (
          <div className="eje-scrollbar overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-steel-100 bg-steel-50 text-xs tracking-wide text-steel-500 uppercase">
                  <th className="px-5 py-2.5 text-left font-semibold">Description</th>
                  <th className="px-5 py-2.5 text-right font-semibold">Amount</th>
                  {editable && <th className="w-12" />}
                </tr>
              </thead>
              <tbody>
                {job.additionalCharges.map((entry) => (
                  <tr key={entry.id} className="border-b border-steel-100 last:border-b-0">
                    <td className="px-5 py-3 text-steel-800">{entry.description}</td>
                    <td className="tabular px-5 py-3 text-right font-semibold text-steel-900">
                      {formatCurrency(entry.amount)}
                    </td>
                    {editable && (
                      <td className="pr-3">
                        <LineActions
                          onEdit={() => {
                            setEditingId(entry.id);
                            setDialog('additional_charge');
                          }}
                          onRemove={() =>
                            setPendingRemoval({
                              kind: 'additional_charge',
                              id: entry.id,
                              label: `${entry.description} — ${formatCurrency(entry.amount)}`,
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
        DISCOUNTS WERE WITHDRAWN on 27 October 2026 (DISCOUNT-OFF-1, the owner's
        instruction). Nothing here applies or removes one any more, and the
        server has no command for it. A job that already carries a discount
        keeps it — its totals and its signed document are history — so it is
        SHOWN, read-only, and said to be historical.
      */}
      {job.discount !== null && (
        <Card>
          <CardHeader
            title="Discount (historical)"
            description={`${formatCurrency(job.discount.amount)} off — ${job.discount.reason}`}
          />
          <p className="mt-2 text-xs text-steel-500">
            Recorded before discounts were withdrawn. It stays on this job and its job card; a new
            discount cannot be applied.
          </p>
        </Card>
      )}

      {/*
        THE CALL-OUT FEE SITS UNDER PARTS, not up beside Labour.

        It is the last commercial decision taken on a job — what was fitted,
        then whether the visit itself is charged — and it belongs beside the
        other charge the office adds rather than in the middle of the hours the
        technician is capturing. Nothing about the fee itself changed: it is
        still off unless somebody turns it on, still never inferred from the
        job type, and still priced by the same rate.

        It is inside the labour-and-travel guard for the same reason as before:
        a parts collection carries no call-out.
      */}
      {capturesLabourAndTravel && (
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
                  const applied = event.target.checked;
                  const ok = await operation.run(() => jobs.setCallout(job.id, applied));
                  if (ok) onChanged();
                }}
                className="size-4.5 rounded border-steel-300 text-eje-600 focus:ring-eje-500"
              />
              Charge the call-out fee
            </label>
          </div>
          <p className="mt-2 text-xs text-steel-500">
            Whether a call-out is charged is a commercial decision per job, so it is set here
            rather than assumed from the job type.
          </p>
          {/* BENCH-1: beside the call-out, optional, off unless ticked, charged once. */}
          <div className="mt-4 flex flex-wrap items-start justify-between gap-4 border-t border-steel-100 pt-4">
            <CardHeader
              title="Test bench fee"
              description={
                job.testBenchApplied
                  ? `Applied — ${formatCurrency(totals.pricing.testBenchFee ?? 0)}`
                  : 'Not applied to this job'
              }
            />
            <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm font-medium text-steel-700">
              <input
                type="checkbox"
                checked={job.testBenchApplied}
                disabled={!editable || operation.running}
                onChange={async (event) => {
                  const applied = event.target.checked;
                  const ok = await operation.run(() => jobs.setTestBench(job.id, applied));
                  if (ok) onChanged();
                }}
                className="size-4.5 rounded border-steel-300 text-eje-600 focus:ring-eje-500"
                data-testid="test-bench-checkbox"
              />
              Charge the test bench fee
            </label>
          </div>
        </Card>
      )}

      {/*
        One dialog per kind, used for BOTH adding and amending. `editingId`
        decides which, so the technician always sees the same form and an
        amendment cannot drift away from the shape of the original entry.
      */}
      <LabourDialog
        key={`labour-${editingId ?? 'new'}-${dialogNonce}`}
        open={dialog === 'labour'}
        existing={job.labour.find((entry) => entry.id === editingId) ?? null}
        onClose={closeDialog}
        onSubmit={async (values) => {
          if (editingId === null) {
            const result = await capture.capture(
              'add_labour',
              values,
              `${values.hours} h ${labourRateLabel(values.rateType).toLowerCase()}${
                values.description.length > 0 ? ` — ${values.description}` : ''
              }`,
            );
            if (result.kind === 'refused') return;
            setHeld(result.kind === 'queued' ? 'labour' : null);
            closeDialog();
            onChanged();
            return;
          }
          const ok = await operation.run(() =>
            jobs.updateLabour(job.id, { ...values, lineId: editingId }),
          );
          if (ok) {
            closeDialog();
            onChanged();
          }
        }}
        busy={operation.running || capture.running}
        pricing={totals.pricing}
      />

      <TravelDialog
        key={`travel-${editingId ?? 'new'}-${dialogNonce}`}
        open={dialog === 'travel'}
        existing={job.travel.find((entry) => entry.id === editingId) ?? null}
        onClose={closeDialog}
        onSubmit={async (values) => {
          if (editingId === null) {
            const result = await capture.capture(
              'add_travel',
              values,
              `${values.kilometres} km${
                values.description.length > 0 ? ` — ${values.description}` : ''
              }`,
            );
            if (result.kind === 'refused') return;
            setHeld(result.kind === 'queued' ? 'travel' : null);
            closeDialog();
            onChanged();
            return;
          }
          const ok = await operation.run(() =>
            jobs.updateTravel(job.id, { ...values, lineId: editingId }),
          );
          if (ok) {
            closeDialog();
            onChanged();
          }
        }}
        busy={operation.running || capture.running}
        pricing={totals.pricing}
      />

      <PartDialog
        key={`part-${editingId ?? 'new'}-${dialogNonce}`}
        open={dialog === 'part'}
        existing={job.parts.find((entry) => entry.id === editingId) ?? null}
        onClose={closeDialog}
        onSubmitNew={async (lines) => {
          /*
           * ONE CAPTURE PER LINE, in order, each with its own key — exactly
           * what adding them one at a time would do, so a retry cannot double
           * any of them. A line the server refuses stops the run and stays in
           * the dialog with the server's words; the lines before it are saved.
           */
          let saved = 0;
          let queued = false;
          for (const values of lines) {
            const result = await capture.capture(
              'add_part',
              values,
              `${values.quantity} × ${values.partNumber}${
                values.description.length > 0 ? ` — ${values.description}` : ''
              }`,
            );
            if (result.kind === 'refused') break;
            if (result.kind === 'queued') queued = true;
            saved += 1;
          }
          if (saved > 0) onChanged();
          if (saved === lines.length) {
            setHeld(queued ? 'the parts' : null);
            closeDialog();
          }
          return saved;
        }}
        onSubmitEdit={async (values) => {
          if (editingId === null) return;
          const ok = await operation.run(() =>
            jobs.updatePart(job.id, { ...values, lineId: editingId }),
          );
          if (ok) {
            closeDialog();
            onChanged();
          }
        }}
        refusal={capture.outcome?.kind === 'refused' ? capture.outcome.message : null}
        busy={operation.running || capture.running}
      />

      <AdditionalChargeDialog
        key={`charge-${editingId ?? 'new'}-${dialogNonce}`}
        open={dialog === 'additional_charge'}
        existing={job.additionalCharges.find((entry) => entry.id === editingId) ?? null}
        onClose={closeDialog}
        onSubmit={async (values) => {
          /*
           * NOT THROUGH THE OFFLINE QUEUE, deliberately. A charge is an office
           * act taken at a desk with a connection, not a capture made at a
           * machine — and the queue exists for work a technician cannot
           * otherwise record. Same reasoning as amending a line.
           */
          const ok = await operation.run(() =>
            editingId === null
              ? jobs.addAdditionalCharge(job.id, values)
              : jobs.updateAdditionalCharge(job.id, { ...values, lineId: editingId }),
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
  const [date, setDate] = useState(existing?.date ?? businessToday());
  const [rateType, setRateType] = useState<LabourRateType>(existing?.rateType ?? 'normal');
  const [hours, setHours] = useState(existing === null ? '1' : String(existing.hours));
  const [error, setError] = useState<string | undefined>(undefined);

  const parsedHours = Number.parseFloat(hours);
  const rate = labourRateFor(pricing, rateType);

  const submit = () => {
    if (!Number.isFinite(parsedHours) || parsedHours <= 0) {
      setError('Enter the number of hours worked.');
      return;
    }
    setError(undefined);
    /*
     * NO DESCRIPTION IS ASKED FOR ANY MORE. MASTER SCOPE LAB-1.
     *
     * What was done is the COMPLETION WRITE-UP — the formal, customer-facing
     * technical record — and asking for it again per labour line got the same
     * work described twice, differently, on one document. A labour line is
     * hours at a rate.
     *
     * The field itself stays on the record and is passed straight through, so
     * amending the hours on a line captured under the old form keeps what that
     * technician wrote rather than silently erasing it. Historical job cards
     * print exactly as they did.
     */
    onSubmit({
      date,
      rateType,
      hours: parsedHours,
      description: existing?.description ?? '',
    });
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

        <p className="rounded-[var(--radius-control)] bg-steel-50 px-3 py-2.5 text-xs text-steel-600">
          What was done goes in the <span className="font-semibold">Completion write-up</span> —
          it is the technical record printed on the customer&rsquo;s job card. A labour line
          records the hours only.
        </p>

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
  const [date, setDate] = useState(existing?.date ?? businessToday());
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

type PartValues = {
  partNumber: string;
  description: string;
  quantity: number;
  unitPrice: number;
};

interface PartRow {
  readonly key: number;
  readonly partNumber: string;
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: string;
}

const blankRow = (key: number): PartRow => ({ key, partNumber: '', description: '', quantity: '1', unitPrice: '' });

const rowErrors = (row: PartRow): Record<string, string> => {
  const errors: Record<string, string> = {};
  const quantity = Number(row.quantity);
  const price = Number.parseFloat(row.unitPrice);
  if (row.partNumber.trim().length === 0) errors.partNumber = 'A part number is required.';
  if (row.description.trim().length === 0) errors.description = 'A description is required.';
  if (!Number.isInteger(quantity) || quantity <= 0) errors.quantity = 'Enter a whole quantity.';
  if (!Number.isFinite(price) || price < 0) errors.unitPrice = 'Enter a unit price.';
  return errors;
};

const valuesOf = (row: PartRow): PartValues => ({
  partNumber: row.partNumber.trim(),
  description: row.description.trim(),
  quantity: Number(row.quantity),
  // Prices are entered in rands and stored in cents.
  unitPrice: Math.round(Number.parseFloat(row.unitPrice) * 100),
});

/**
 * ADDING PARTS — as many as the job needs. PARTS-MULTI-1, 27 October 2026.
 *
 * A NEW entry takes several lines at once: each with its own part number,
 * description, quantity and unit price, its own line total, and a *Remove* for
 * a line not yet saved. Saving adds each line through the ordinary capture, in
 * order. EDITING one existing line is unchanged — one line, one form.
 */
const PartDialog = ({
  open,
  onClose,
  onSubmitNew,
  onSubmitEdit,
  busy,
  existing,
  refusal,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Adds the lines in order; answers how many were saved. */
  readonly onSubmitNew: (lines: readonly PartValues[]) => Promise<number>;
  readonly onSubmitEdit: (values: PartValues) => void;
  readonly busy: boolean;
  readonly existing: PartEntry | null;
  readonly refusal: string | null;
}) => {
  const [rows, setRows] = useState<readonly PartRow[]>(() =>
    existing === null
      ? [blankRow(0)]
      : [
          {
            key: 0,
            partNumber: existing.partNumber,
            description: existing.description,
            quantity: String(existing.quantity),
            unitPrice: (existing.unitPrice / 100).toFixed(2),
          },
        ],
  );
  const [nextKey, setNextKey] = useState(1);
  const [errors, setErrors] = useState<Record<number, Record<string, string>>>({});

  const change = (key: number, field: keyof Omit<PartRow, 'key'>, value: string) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, [field]: value } : row)));

  // Held across the per-line saves, so a second click cannot resubmit saved rows.
  const [submitting, setSubmitting] = useState(false);
  const submit = async () => {
    if (submitting) return;
    const found: Record<number, Record<string, string>> = {};
    for (const row of rows) {
      const problems = rowErrors(row);
      if (Object.keys(problems).length > 0) found[row.key] = problems;
    }
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    if (existing !== null) {
      onSubmitEdit(valuesOf(rows[0]!));
      return;
    }
    setSubmitting(true);
    try {
      const saved = await onSubmitNew(rows.map(valuesOf));
      // The lines that were saved leave the form; anything refused stays to be fixed.
      setRows((current) => current.slice(saved));
    } finally {
      setSubmitting(false);
    }
  };

  const grandTotal = rows.reduce((sum, row) => {
    const quantity = Number(row.quantity);
    const price = Number.parseFloat(row.unitPrice);
    return Number.isFinite(quantity) && Number.isFinite(price) ? sum + Math.round(quantity * price * 100) : sum;
  }, 0);

  return (
    <Modal
      open={open}
      title={existing === null ? 'Add parts' : 'Edit part'}
      description="Parts fitted on this job. Prices are entered excluding VAT."
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={busy || submitting} data-testid="save-parts">
            {existing === null ? (rows.length === 1 ? 'Add part' : `Add ${rows.length} parts`) : 'Save changes'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {refusal !== null && (
          <p role="alert" className="text-sm font-medium text-signal-600">
            {refusal}
          </p>
        )}
        {rows.map((row, index) => {
          const rowError = errors[row.key] ?? {};
          const quantity = Number(row.quantity);
          const price = Number.parseFloat(row.unitPrice);
          return (
            <div
              key={row.key}
              className="space-y-3 rounded-[var(--radius-control)] border border-steel-200 p-3"
              data-testid="part-line"
            >
              {existing === null && (
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold tracking-wide text-steel-500 uppercase">Part {index + 1}</p>
                  {rows.length > 1 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setRows((current) => current.filter((candidate) => candidate.key !== row.key))}
                      data-testid="remove-part-line"
                    >
                      Remove
                    </Button>
                  )}
                </div>
              )}
              <TextField
                label="Part number"
                value={row.partNumber}
                onChange={(event) => change(row.key, 'partNumber', event.target.value)}
                error={rowError.partNumber}
                placeholder="e.g. FLT-CAB-220"
                required
              />
              <TextField
                label="Description"
                value={row.description}
                onChange={(event) => change(row.key, 'description', event.target.value)}
                error={rowError.description}
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
                  value={row.quantity}
                  onChange={(event) => change(row.key, 'quantity', event.target.value)}
                  error={rowError.quantity}
                  required
                />
                <TextField
                  label="Unit price (excl. VAT)"
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  value={row.unitPrice}
                  onChange={(event) => change(row.key, 'unitPrice', event.target.value)}
                  error={rowError.unitPrice}
                  placeholder="0.00"
                  required
                />
              </div>
              {Number.isFinite(quantity) && Number.isFinite(price) && price >= 0 && (
                <p className="text-sm text-steel-600">
                  Line total:{' '}
                  <span className="tabular font-semibold text-steel-900">
                    {formatCurrency(Math.round(quantity * price * 100))}
                  </span>
                </p>
              )}
            </div>
          );
        })}
        {existing === null && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button
              size="sm"
              variant="secondary"
              leadingIcon={<Icon name="plus" className="size-4" />}
              onClick={() => {
                setRows((current) => [...current, blankRow(nextKey)]);
                setNextKey((value) => value + 1);
              }}
              data-testid="add-part-line"
            >
              Add another part
            </Button>
            <p className="text-sm text-steel-600">
              Parts total: <span className="tabular font-semibold text-steel-900">{formatCurrency(grandTotal)}</span>
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
};

/**
 * A charge that is neither labour, nor travel, nor a part. COST-5.
 *
 * Two fields, because that is what the thing is: what it is for, and how much.
 * No quantity and no unit price — inventing a quantity of one at a unit price
 * equal to the total would put two numbers on a customer's document that say
 * nothing and can disagree.
 */
const AdditionalChargeDialog = ({
  open,
  onClose,
  onSubmit,
  busy,
  existing,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (values: { description: string; amount: number }) => void;
  readonly busy: boolean;
  readonly existing: AdditionalChargeEntry | null;
}) => {
  const [description, setDescription] = useState(existing?.description ?? '');
  const [amount, setAmount] = useState(
    existing === null ? '' : (existing.amount / 100).toFixed(2),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  const parsedAmount = Number.parseFloat(amount);

  const submit = () => {
    const next: Record<string, string> = {};
    if (description.trim().length === 0) {
      next.description = 'Say what the charge is for. It is printed on the customer’s job card.';
    }
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      next.amount = 'Enter an amount. A charge of nothing is not a charge.';
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    onSubmit({
      description: description.trim(),
      // Entered in rands, stored in cents — the same rule as a part price.
      amount: Math.round(parsedAmount * 100),
    });
  };

  return (
    <Modal
      open={open}
      title={existing === null ? 'Add a charge' : 'Edit the charge'}
      description="Anything that is not labour, travel or a part. Entered excluding VAT."
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy}>
            {existing === null ? 'Add charge' : 'Save changes'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <TextField
          label="What the charge is for"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          error={errors.description}
          placeholder="e.g. Workshop consumables and cleaning materials"
          required
        />
        <TextField
          label="Amount (excl. VAT)"
          type="number"
          min="0"
          step="0.01"
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          error={errors.amount}
          placeholder="0.00"
          required
        />
      </div>
    </Modal>
  );
};
