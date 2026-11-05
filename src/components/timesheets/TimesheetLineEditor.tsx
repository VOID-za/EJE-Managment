'use client';

import { useEffect, useRef, useState } from 'react';
import { WORKSHOP_LABEL, type TimesheetLineTyped } from '@/domain';
import { Badge, Button, SelectField, TextField } from '@/components/ui';
import { formatCurrency } from '@/lib/format';
import { formatPeriod } from '@/lib/timesheet-dates';
import { WORKSHOP_PICK, timesheetLineProblems, type TimesheetLineField } from '@/lib/timesheet-line';
import type { TimesheetAutosaver } from '@/lib/timesheet-autosave';
import type { WorkingTimesheetLine } from '@/application/timesheet-lines';

/** A line as the editor needs it: from the server, or added on this screen and not saved yet. */
export interface EditableLine {
  readonly id: string;
  readonly date: string | null;
  readonly typed: TimesheetLineTyped;
  readonly revision: string | null;
  readonly complete: boolean;
  readonly problems: WorkingTimesheetLine['problems'];
  readonly historical: WorkingTimesheetLine['historical'];
  readonly submitted: WorkingTimesheetLine['submitted'];
}

const hours = (value: string): string => {
  const parsed = Number.parseFloat(value.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed.toFixed(2) : value;
};

/**
 * ONE TIMESHEET LINE, EDITED WHERE IT IS (PAYROLL-ONE-1). Every field is
 * typed straight into the line — no form to open, no Save to press — and each
 * change goes to the autosaver, which saves it a moment later. The line says
 * where it stands: Saving…, Saved, Draft (with what it still needs), or Save
 * failed. The typing lives in this component, so typing never re-renders the
 * page (TST-TS-2 #1), and the server's newer line replaces it only when
 * nothing typed here is waiting.
 *
 * A line in a current submission is shown read-only: it is changed by a
 * correction (Submitted timesheets), never by typing over it.
 */
export const TimesheetLineEditor = ({
  line,
  customers,
  saver,
  editable,
}: {
  readonly line: EditableLine;
  readonly customers: readonly { readonly id: string; readonly name: string }[];
  readonly saver: TimesheetAutosaver | null;
  readonly editable: boolean;
}) => {
  const [typed, setTyped] = useState<TimesheetLineTyped>(line.typed);
  const [date, setDate] = useState<string>(line.date ?? '');
  const shownRevision = useRef(line.revision);
  const pending = saver?.pendingFor(line.id) ?? null;

  // The server's newer line (a reload, a conflict) replaces what is shown — only when nothing typed here waits.
  useEffect(() => {
    if (line.revision === shownRevision.current || pending !== null) return;
    shownRevision.current = line.revision;
    setTyped(line.typed);
    setDate(line.date ?? '');
  }, [line.revision, line.typed, line.date, pending]);

  const change = (next: TimesheetLineTyped, nextDate: string = date) => {
    setTyped(next);
    setDate(nextDate);
    saver?.change({ kind: 'line', id: line.id, date: nextDate === '' ? null : nextDate, typed: next, base: line.revision });
  };

  const live = timesheetLineProblems(date === '' ? null : date, typed);
  const problems = pending !== null ? live : line.problems;
  const problemOf = (field: TimesheetLineField) => problems.find((problem) => problem.field === field)?.message;
  const status = line.submitted !== null
    ? 'submitted'
    : pending?.refused !== undefined
      ? 'failed'
      : pending !== null
        ? 'saving'
        : line.complete && problems.length === 0
          ? 'saved'
          : 'draft';

  if (line.submitted !== null || !editable) {
    return (
      <li className="grid grid-cols-2 gap-x-4 gap-y-1 py-2 text-sm lg:grid-cols-[minmax(0,1.6fr)_repeat(5,minmax(0,0.7fr))_auto] lg:items-center" data-testid="timesheet-line" data-line-id={line.id} data-date={line.date ?? ''} data-state={status}>
        <span className="col-span-2 text-steel-900 lg:col-span-1">{typed.pick === WORKSHOP_PICK ? WORKSHOP_LABEL : typed.customerName || '—'}</span>
        <span><span className="text-xs text-steel-500 lg:hidden">OT </span>{hours(typed.overtime)}</span>
        <span><span className="text-xs text-steel-500 lg:hidden">D/T </span>{hours(typed.double)}</span>
        <span><span className="text-xs text-steel-500 lg:hidden">Callout </span>{formatCurrency(Math.round(Number.parseFloat(typed.callout) * 100) || 0)}</span>
        <span><span className="text-xs text-steel-500 lg:hidden">Int Km </span>{typed.internalKm}</span>
        <span><span className="text-xs text-steel-500 lg:hidden">Cust Km </span>{typed.customerKm}</span>
        {line.submitted !== null && (
          <span className="col-span-2 lg:col-span-1" data-testid="timesheet-line-submitted">
            <Badge tone="green" size="sm">Submitted {formatPeriod(line.submitted.from, line.submitted.to)}</Badge>
          </span>
        )}
      </li>
    );
  }

  const customerOptions = [
    { value: '', label: 'Type the customer (or none)…' },
    { value: WORKSHOP_PICK, label: WORKSHOP_LABEL },
    ...customers.map((customer) => ({ value: customer.id, label: customer.name })),
  ];
  const number = (label: string, field: 'overtime' | 'double' | 'callout' | 'internalKm' | 'customerKm', testId: string) => (
    <TextField
      label={label}
      inputMode="decimal"
      autoComplete="off"
      value={typed[field]}
      error={problemOf(field)}
      onChange={(event) => change({ ...typed, [field]: event.target.value })}
      onBlur={() => saver?.flushNow()}
      data-testid={testId}
    />
  );

  return (
    <li
      className={`space-y-2 rounded-[var(--radius-control)] border p-3 ${status === 'draft' || status === 'failed' ? 'border-amber-eje-200 bg-amber-eje-50/40' : 'border-steel-200'}`}
      data-testid="timesheet-line"
      data-line-id={line.id}
      data-date={line.date ?? ''}
      data-state={status}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_minmax(0,1fr)]">
        <TextField
          label="Date"
          type="date"
          value={date}
          error={problemOf('date')}
          onChange={(event) => change(typed, event.target.value)}
          data-testid="timesheet-line-date"
        />
        <SelectField
          label="Customer or Workshop"
          value={typed.pick}
          options={customerOptions}
          data-testid="timesheet-customer-pick"
          onChange={(event) => {
            const value = event.target.value;
            const picked = customers.find((customer) => customer.id === value);
            change({ ...typed, pick: value, customerName: value === WORKSHOP_PICK ? '' : picked?.name ?? (typed.pick === WORKSHOP_PICK ? '' : typed.customerName) });
          }}
        />
        {typed.pick !== WORKSHOP_PICK && (
          <TextField
            label="Customer"
            value={typed.customerName}
            maxLength={200}
            autoComplete="off"
            error={problemOf('customer')}
            onChange={(event) => change({ ...typed, customerName: event.target.value })}
            onBlur={() => saver?.flushNow()}
            data-testid="timesheet-customer-name"
          />
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {number('OT (hours)', 'overtime', 'timesheet-overtime')}
        {number('D/T (hours)', 'double', 'timesheet-double')}
        {number('Callout (R)', 'callout', 'timesheet-callout')}
        {number('Int Km', 'internalKm', 'timesheet-internal-km')}
        {number('Cust Km', 'customerKm', 'timesheet-customer-km')}
      </div>
      {(line.historical.normalHours > 0 || line.historical.callouts > 0) && (
        <p className="text-xs text-steel-500">
          Entered before 28 October 2026 with{line.historical.normalHours > 0 ? ` NT ${line.historical.normalHours.toFixed(2)} h` : ''}
          {line.historical.callouts > 0 ? ` ${line.historical.callouts} call-out(s)` : ''} — kept as it was.
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs" data-testid="timesheet-line-status" role="status" aria-live="polite">
          {status === 'saving' && <span className="text-steel-600">Saving…</span>}
          {status === 'saved' && <span className="text-verdant-700">Saved</span>}
          {status === 'failed' && <span className="font-medium text-signal-600">Save failed — {pending?.refused}</span>}
          {status === 'draft' && <span className="font-medium text-amber-eje-700">Draft — saved, not complete yet</span>}
        </span>
        <Button size="sm" variant="ghost" onClick={() => saver?.change({ kind: 'remove', id: line.id })} data-testid="remove-timesheet-line">
          Remove line
        </Button>
      </div>
      {problems.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-amber-eje-700" data-testid="timesheet-line-problems">
          {problems.map((problem) => <li key={problem.message}>{problem.message}</li>)}
        </ul>
      )}
    </li>
  );
};
