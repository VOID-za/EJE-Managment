'use client';

import { useState } from 'react';
import { WORKSHOP_LABEL, can, type TimesheetEntry, type User } from '@/domain';
import { Badge, Button, Icon, SelectField, TextAreaField, TextField } from '@/components/ui';
import { DocumentPreviewDialog } from '@/components/documents/DocumentPreviewDialog';
import { TimesheetDocumentView } from '@/components/timesheets/TimesheetDocumentView';
import { timesheets } from '@/api/endpoints';
import type { TimesheetCorrectionView, TimesheetDocument, TimesheetPeriodState } from '@/application/timesheets';
import { useOperation } from '@/hooks/useOperation';
import { formatCurrency, formatDateTime } from '@/lib/format';
import { formatDayAndDate } from '@/lib/timesheet-dates';

const WORKSHOP = '__workshop__';

/** One corrected line, as typed. */
interface Row {
  readonly key: string;
  readonly entryId?: string;
  readonly date: string;
  readonly pick: string;
  readonly customerName: string;
  readonly overtime: string;
  readonly double: string;
  readonly callout: string;
  readonly calloutShared: boolean;
  readonly internalKm: string;
  readonly customerKm: string;
  readonly keepNormal?: number;
  readonly keepCallouts?: number;
}

const rowOf = (entry: TimesheetEntry): Row => ({
  key: entry.id,
  entryId: entry.id,
  date: entry.date,
  pick: entry.workshop ? WORKSHOP : entry.customerId ?? '',
  customerName: entry.workshop ? '' : entry.customerName,
  overtime: String(entry.overtimeHours),
  double: String(entry.doubleHours),
  callout: (entry.calloutAmount / 100).toFixed(2),
  calloutShared: entry.calloutShared,
  internalKm: String(entry.internalKm),
  customerKm: String(entry.customerKm),
  keepNormal: entry.normalHours,
  keepCallouts: entry.callouts,
});

const parse = (value: string): number => Number.parseFloat(value.replace(',', '.'));

const STATUS: Record<TimesheetCorrectionView['status'], { label: string; tone: 'amber' | 'green' | 'red' }> = {
  pending: { label: 'Pending the office’s review', tone: 'amber' },
  accepted: { label: 'Accepted', tone: 'green' },
  rejected: { label: 'Rejected', tone: 'red' },
};

const lineText = (entry: TimesheetEntry): string =>
  `${entry.workshop ? WORKSHOP_LABEL : entry.customerName || '—'} · OT ${entry.overtimeHours} · D/T ${entry.doubleHours} · ${formatCurrency(entry.calloutAmount)}${entry.calloutShared ? ' (shared)' : ''} · Int ${entry.internalKm} km · Cust ${entry.customerKm} km`;

/**
 * CORRECTING A SENT TIMESHEET. TS-16 (29 October 2026).
 *
 * The sent timesheet never changes. Its technician asks for a correction —
 * the reason and the complete corrected lines — and the office (a Master or a
 * Coordinator who did not ask) accepts it or rejects it with a note. Every
 * correction stays listed with who, when, why, the decision and exactly what
 * it changes; any version — the original, each correction — can be previewed.
 * The version in force is the one last accepted.
 */
export const TimesheetCorrections = ({
  user,
  personId,
  period,
  entries,
  owner,
  customers,
  onChanged,
}: {
  readonly user: User;
  readonly personId: string;
  readonly period: TimesheetPeriodState;
  /** The version in force's lines: what a new correction starts from. */
  readonly entries: readonly TimesheetEntry[];
  readonly owner: boolean;
  readonly customers: readonly { readonly id: string; readonly name: string }[];
  readonly onChanged: () => void;
}) => {
  const operation = useOperation();
  const [rows, setRows] = useState<readonly Row[] | null>(null);
  const [comment, setComment] = useState('');
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [previewing, setPreviewing] = useState<{ version: string; title: string } | null>(null);
  const [previewDocument, setPreviewDocument] = useState<TimesheetDocument | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const reviewer = can(user.role, 'timesheets.reviewCorrections');
  const pending = period.corrections.find((correction) => correction.status === 'pending') ?? null;
  const anyAccepted = period.corrections.some((correction) => correction.status === 'accepted');

  const openPreview = (version: string, title: string) => {
    setPreviewDocument(null);
    setPreviewing({ version, title });
    void timesheets
      .document(personId, period.from, period.to, version)
      .then(setPreviewDocument)
      .catch(() => setPreviewDocument(null));
  };

  const startCorrection = () => {
    setRows(entries.map(rowOf));
    setComment(period.comment);
    setReason('');
    setDone(null);
    operation.clearError();
  };

  const change = (key: string, patch: Partial<Row>) =>
    setRows((current) => (current ?? []).map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const submit = async () => {
    if (rows === null) return;
    const ok = await operation.run(async () => {
      await timesheets.requestCorrection(personId, {
        from: period.from,
        to: period.to,
        reason,
        comment,
        lines: rows.map((row) => {
          const workshop = row.pick === WORKSHOP;
          return {
            ...(row.entryId === undefined ? {} : { entryId: row.entryId }),
            date: row.date,
            customerId: workshop || row.pick.length === 0 ? null : row.pick,
            customerName: workshop ? '' : row.customerName,
            workshop,
            ...(row.keepNormal === undefined ? {} : { normalHours: row.keepNormal }),
            ...(row.keepCallouts === undefined ? {} : { callouts: row.keepCallouts }),
            overtimeHours: parse(row.overtime),
            doubleHours: parse(row.double),
            calloutAmount: Math.round(parse(row.callout) * 100),
            calloutShared: row.calloutShared,
            internalKm: parse(row.internalKm),
            customerKm: parse(row.customerKm),
          };
        }),
      });
    });
    if (ok) {
      setRows(null);
      setDone('Correction sent to the office for review. The timesheet that was sent is unchanged until it is accepted.');
      onChanged();
    }
  };

  const decide = async (correction: TimesheetCorrectionView, decision: 'accept' | 'reject') => {
    const ok = await operation.run(async () => {
      await timesheets.decideCorrection(personId, correction.id, decision, notes[correction.id] ?? '');
    });
    if (ok) {
      setDone(decision === 'accept' ? `Correction ${correction.sequence} accepted — it is now the version in force.` : `Correction ${correction.sequence} rejected.`);
      onChanged();
    }
  };

  const days: string[] = [];
  for (let at = Date.parse(`${period.from}T00:00:00Z`); at <= Date.parse(`${period.to}T00:00:00Z`); at += 86_400_000) {
    days.push(new Date(at).toISOString().slice(0, 10));
  }
  const customerOptions = [
    { value: '', label: 'Type the customer…' },
    { value: WORKSHOP, label: WORKSHOP_LABEL },
    ...customers.map((customer) => ({ value: customer.id, label: customer.name })),
  ];

  return (
    <div className="mt-4 border-t border-steel-100 pt-4" data-testid="timesheet-corrections">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold text-steel-900">Corrections</p>
        <span data-testid="timesheet-version-in-force">
          <Badge tone="outline" size="sm">In force: {period.versionInForce}</Badge>
        </span>
        {anyAccepted && (
          <Button size="sm" variant="ghost" onClick={() => openPreview('original', 'Original submission')} data-testid="timesheet-preview-original">
            Preview the original submission
          </Button>
        )}
      </div>

      {period.corrections.length === 0 && (
        <p className="mt-2 text-sm text-steel-600">
          None. The timesheet that was sent is the version in force.
        </p>
      )}

      <ol className="mt-2 space-y-3">
        {period.corrections.map((correction) => (
          <li
            key={correction.id}
            className="rounded-[var(--radius-control)] border border-steel-200 p-3 text-sm"
            data-testid="timesheet-correction"
            data-status={correction.status}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-steel-900">Correction {correction.sequence}</span>
              <Badge tone={STATUS[correction.status].tone} size="sm">{STATUS[correction.status].label}</Badge>
              <Button size="sm" variant="ghost" onClick={() => openPreview(String(correction.sequence), `Correction ${correction.sequence}`)}>
                Preview this version
              </Button>
            </div>
            <p className="mt-1 text-steel-600">
              Asked for {formatDateTime(correction.requestedAt)}
              {correction.requestedByName ? ` by ${correction.requestedByName}` : ''}. Reason: {correction.reason}
            </p>
            {correction.decidedAt !== null && (
              <p className="mt-1 text-steel-600" data-testid="timesheet-correction-decision">
                {correction.status === 'accepted' ? 'Accepted' : 'Rejected'} {formatDateTime(correction.decidedAt)}
                {correction.decidedByName ? ` by ${correction.decidedByName}` : ''}
                {correction.decisionNote ? `. Note: ${correction.decisionNote}` : '.'}
              </p>
            )}
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-steel-800" data-testid="timesheet-correction-changes">
              {correction.changes.map((text, index) => (
                <li key={index}>{text}</li>
              ))}
            </ul>
            {reviewer && correction.status === 'pending' && correction.requestedById !== user.id && (
              <div className="mt-3 space-y-2">
                <TextAreaField
                  label="Note to the technician (required to reject)"
                  rows={2}
                  maxLength={2000}
                  value={notes[correction.id] ?? ''}
                  onChange={(event) => setNotes({ ...notes, [correction.id]: event.target.value })}
                  data-testid="timesheet-correction-note"
                />
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" loading={operation.running} onClick={() => void decide(correction, 'accept')} data-testid="timesheet-correction-accept">
                    Accept correction
                  </Button>
                  <Button size="sm" variant="secondary" loading={operation.running} onClick={() => void decide(correction, 'reject')} data-testid="timesheet-correction-reject">
                    Reject
                  </Button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ol>

      {owner && pending === null && rows === null && (
        <Button className="mt-3" variant="secondary" onClick={startCorrection} data-testid="timesheet-correction-start">
          <Icon name="edit" className="size-4" /> Ask for a correction
        </Button>
      )}
      {owner && pending !== null && rows === null && (
        <p className="mt-3 text-sm text-amber-eje-700" role="status">
          Correction {pending.sequence} is waiting for the office. Another can be asked for once it is decided.
        </p>
      )}

      {rows !== null && (
        <div className="mt-3 space-y-3 rounded-[var(--radius-control)] border border-eje-200 bg-eje-50/40 p-3" data-testid="timesheet-correction-form">
          <p className="text-sm text-steel-700">
            The complete corrected timesheet for these dates. Change, add or remove lines; the office sees exactly what changes and accepts or rejects it. The timesheet that was sent stays on record.
          </p>
          {rows.length === 0 && <p className="text-sm text-steel-500">No lines.</p>}
          {rows.map((row) => (
            <div key={row.key} className="space-y-2 rounded border border-steel-200 bg-white p-2" data-testid="timesheet-correction-row">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <SelectField
                  label="Date"
                  value={row.date}
                  options={days.map((day) => ({ value: day, label: formatDayAndDate(day) }))}
                  onChange={(event) => change(row.key, { date: event.target.value })}
                />
                <SelectField
                  label="Customer or Workshop"
                  value={row.pick}
                  options={customerOptions}
                  onChange={(event) => {
                    const picked = customers.find((customer) => customer.id === event.target.value);
                    change(row.key, { pick: event.target.value, customerName: event.target.value === WORKSHOP ? '' : picked?.name ?? row.customerName });
                  }}
                />
                {row.pick !== WORKSHOP && (
                  <TextField label="Customer" value={row.customerName} maxLength={200} onChange={(event) => change(row.key, { customerName: event.target.value })} />
                )}
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <TextField label="OT (hours)" inputMode="decimal" value={row.overtime} onChange={(event) => change(row.key, { overtime: event.target.value })} data-testid="timesheet-correction-ot" />
                <TextField label="D/T (hours)" inputMode="decimal" value={row.double} onChange={(event) => change(row.key, { double: event.target.value })} />
                <TextField label="Callout (R)" inputMode="decimal" value={row.callout} onChange={(event) => change(row.key, { callout: event.target.value })} />
                <TextField label="Int Km" inputMode="decimal" value={row.internalKm} onChange={(event) => change(row.key, { internalKm: event.target.value })} />
                <TextField label="Cust Km" inputMode="decimal" value={row.customerKm} onChange={(event) => change(row.key, { customerKm: event.target.value })} />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-sm text-steel-700">
                  <input
                    type="checkbox"
                    checked={row.calloutShared}
                    onChange={(event) => change(row.key, { calloutShared: event.target.checked })}
                    className="size-4.5 rounded border-steel-300 text-eje-600"
                  />
                  Shared call-out (your share only)
                </label>
                <Button size="sm" variant="ghost" onClick={() => setRows(rows.filter((other) => other.key !== row.key))}>
                  Remove line
                </Button>
              </div>
            </div>
          ))}
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              setRows([
                ...rows,
                {
                  key: `new-${rows.length}-${Math.random().toString(36).slice(2)}`,
                  date: period.from,
                  pick: '',
                  customerName: '',
                  overtime: '0',
                  double: '0',
                  callout: '0',
                  calloutShared: false,
                  internalKm: '0',
                  customerKm: '0',
                },
              ])
            }
            data-testid="timesheet-correction-add"
          >
            <Icon name="plus" className="size-4" /> Add line
          </Button>
          <TextAreaField label="Comments (corrected)" rows={2} maxLength={2000} value={comment} onChange={(event) => setComment(event.target.value)} />
          <TextAreaField
            label="Why does it need correcting?"
            rows={2}
            maxLength={2000}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            data-testid="timesheet-correction-reason"
          />
          <div className="flex flex-wrap gap-2">
            <Button loading={operation.running} onClick={() => void submit()} data-testid="timesheet-correction-submit">
              Send correction for review
            </Button>
            <Button variant="ghost" onClick={() => setRows(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {done !== null && (
        <p role="status" className="mt-2 text-sm text-verdant-700" data-testid="timesheet-correction-done">
          {done}
        </p>
      )}
      {operation.error !== null && (
        <p role="alert" className="mt-2 text-sm font-medium text-signal-600" data-testid="timesheet-correction-error">
          {operation.error}
        </p>
      )}

      <DocumentPreviewDialog
        open={previewing !== null}
        title={`Time Sheet — ${previewing?.title ?? ''}`}
        description="A version of the timesheet that was sent. Looking at it changes nothing."
        loadPdf={() => timesheets.pdf(personId, period.from, period.to, previewing?.version ?? 'current')}
        renderHtml={() => (previewDocument === null ? null : <TimesheetDocumentView document={previewDocument} />)}
        onClose={() => setPreviewing(null)}
      />
      {/* Lines of the version in force, for reference while correcting. */}
      {rows !== null && entries.length > 0 && (
        <details className="mt-2 text-xs text-steel-500">
          <summary>The version in force, as it stands</summary>
          <ul className="mt-1 space-y-0.5">
            {entries.map((entry) => (
              <li key={entry.id}>
                {formatDayAndDate(entry.date)}: {lineText(entry)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
};
