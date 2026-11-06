'use client';

import { useEffect, useRef, useState } from 'react';
import { WORKSHOP_LABEL, type TimesheetLineTyped } from '@/domain';
import { Button, ConfirmDialog, Icon, TextField } from '@/components/ui';
import { formatDayAndDate } from '@/lib/timesheet-dates';
import { WORKSHOP_PICK, sameTypedLine, timesheetLineProblems, type TimesheetLineField } from '@/lib/timesheet-line';
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

export type LineStatus = 'saving' | 'saved' | 'draft' | 'failed';

/**
 * The date and values a line has now: what is waiting to be saved from this device, else what this device
 * saved since the list was read, else the server's.
 */
export const shownLine = (line: EditableLine, saver: TimesheetAutosaver | null): { readonly date: string | null; readonly typed: TimesheetLineTyped } => {
  const waiting = saver?.pendingFor(line.id);
  if (waiting?.kind === 'line') return { date: waiting.date, typed: waiting.typed };
  return saver?.savedLineOf(line.id, line.revision) ?? { date: line.date, typed: line.typed };
};

/**
 * WHERE ONE LINE STANDS: Save failed, Saving…, Saved, or Draft (saved, not
 * complete yet) — never "Saved" before the server said so. Its day block shows
 * the worst of its lines (`dayState`).
 */
export const lineStatus = (
  line: EditableLine,
  saver: TimesheetAutosaver | null,
  /** What the editor shows, when it is asked: a line just added and saved is newer there than in the list. */
  shown: { readonly date: string | null; readonly typed: TimesheetLineTyped } = shownLine(line, saver),
): LineStatus => {
  const pending = saver?.pendingFor(line.id) ?? null;
  if (pending?.refused !== undefined) return 'failed';
  if (pending !== null) return 'saving';
  const savedRevision = saver?.revisionOf(line.id) ?? null;
  // Saved here more recently than the copy on screen (the list has not reloaded yet): what was typed is what was saved.
  if (savedRevision !== null && savedRevision !== line.revision) {
    return timesheetLineProblems(shown.date, shown.typed).length === 0 ? 'saved' : 'draft';
  }
  return line.complete && line.problems.length === 0 ? 'saved' : 'draft';
};

/**
 * ONE CUSTOMER OR SITE VISIT OF A DAY — A WORKING TIMESHEET LINE, EDITED WHERE
 * IT IS (PAYROLL-ONE-1, TS-DAY-1). Every field is typed straight into the line
 * — no form to open, no Save to press — and each change goes to the autosaver,
 * which saves it a moment later. A line that has saved stays exactly as
 * editable as a new one: only a submission locks a line, and a submitted line
 * is never on the Timesheets page (its corrections are on My Monthly Forms).
 * The line says where it stands: Saving…, Saved, Draft (with what it still
 * needs), or Save failed. The typing lives in this component, so typing never
 * re-renders the page (TST-TS-2 #1), and the server's newer line replaces it
 * only when nothing typed here is waiting.
 *
 * ITS DATE IS ITS DAY'S (`day`): the line is typed under its day block and
 * moves only when the whole day is moved — never on a keystroke in a date
 * field, which used to carry the line to another day mid-typing. A line with
 * no date yet (a draft from before) has its own Date field until one is chosen.
 */
export const TimesheetLineEditor = ({
  line,
  customers,
  saver,
  day,
  position,
}: {
  readonly line: EditableLine;
  readonly customers: readonly { readonly id: string; readonly name: string }[];
  readonly saver: TimesheetAutosaver | null;
  /** The day block it is under; undefined for a line with no date. */
  readonly day?: string;
  /** 1, 2, 3 … within its day. */
  readonly position?: number;
}) => {
  /*
   * WHERE THE TYPING STARTS: a change still waiting in the autosaver, when there is one — the screen may have
   * been rebuilt (a reload of the list) while it waits, and the server's copy is then older than what was typed.
   */
  const waiting = saver?.pendingFor(line.id);
  const start = waiting?.kind === 'line' ? { typed: waiting.typed, date: day ?? waiting.date ?? '' } : { typed: line.typed, date: day ?? line.date ?? '' };
  const [typed, setTyped] = useState<TimesheetLineTyped>(start.typed);
  const [date, setDate] = useState<string>(start.date);
  const [removing, setRemoving] = useState(false);
  const shownRevision = useRef(line.revision);
  // The latest values typed, updated at once: two quick changes never build on a copy from before the first.
  const latest = useRef<{ typed: TimesheetLineTyped; date: string }>(start);
  const pending = saver?.pendingFor(line.id) ?? null;

  // The server's newer line (a reload, a conflict) replaces what is shown — only when nothing typed here waits,
  // and never an OLDER copy fetched while a save was still on its way (the saver knows the revision it last saved).
  const savedRevision = saver?.revisionOf(line.id) ?? null;
  useEffect(() => {
    if (line.revision === shownRevision.current) return;
    // Asked of the saver NOW, not as it was at render: a keystroke may have landed between the render and this effect.
    if (saver?.pendingFor(line.id) != null) return;
    const saved = saver?.revisionOf(line.id) ?? null;
    if (saved !== null && saved !== line.revision) return;
    shownRevision.current = line.revision;
    const serverDate = day ?? line.date ?? '';
    // The same values as typed (450 and 450.00): what the person typed stays as they typed it.
    if (serverDate === latest.current.date && sameTypedLine(line.typed, latest.current.typed)) return;
    latest.current = { typed: line.typed, date: serverDate };
    setTyped(line.typed);
    setDate(serverDate);
  }, [line.revision, line.typed, line.date, pending, savedRevision, saver, line.id, day]);

  const change = (patch: Partial<TimesheetLineTyped>, nextDate?: string) => {
    const next = { ...latest.current.typed, ...patch };
    // Under a day block the line is always on that day: a move of the day reaches the line through `day`.
    const on = day ?? nextDate ?? latest.current.date;
    latest.current = { typed: next, date: on };
    setTyped(next);
    setDate(on);
    saver?.change({ kind: 'line', id: line.id, date: on === '' ? null : on, typed: next, base: line.revision });
  };

  const live = timesheetLineProblems(date === '' ? null : date, typed);
  const ahead = pending !== null || (savedRevision !== null && savedRevision !== line.revision);
  const problems = ahead ? live : line.problems;
  const problemOf = (field: TimesheetLineField) => problems.find((problem) => problem.field === field)?.message;
  const status = lineStatus(line, saver, { date: date === '' ? null : date, typed });

  /*
   * ONE CUSTOMER FIELD (FORM-LIFECYCLE-1): what is typed is the customer; the register's customers and Workshop
   * are offered as it is typed (the page's `timesheet-customer-options` list). Typing a register customer's name
   * exactly picks that customer; "Workshop" is Workshop (TS-06) — so the line stays one row of six fields.
   */
  const customerShown = typed.pick === WORKSHOP_PICK ? WORKSHOP_LABEL : typed.customerName;
  const typeCustomer = (value: string) => {
    const wanted = value.trim().toLowerCase();
    if (wanted === WORKSHOP_LABEL.toLowerCase()) {
      change({ pick: WORKSHOP_PICK, customerName: '' });
      return;
    }
    const known = customers.find((customer) => customer.name.trim().toLowerCase() === wanted);
    change({ pick: known?.id ?? '', customerName: value });
  };
  const cell = (field: TimesheetLineField) =>
    `h-11 w-full rounded-[var(--radius-control)] border bg-surface px-2 text-sm text-steel-900 focus:border-eje-500 focus:ring-2 focus:ring-eje-100 focus:outline-none ${problemOf(field) === undefined ? 'border-steel-300' : 'border-signal-400'}`;
  const which = position === undefined ? '' : `, line ${position}`;
  const number = (label: string, field: 'overtime' | 'double' | 'callout' | 'internalKm' | 'customerKm', testId: string) => (
    <input
      aria-label={`${label}${which}`}
      aria-invalid={problemOf(field) !== undefined}
      inputMode="decimal"
      autoComplete="off"
      className={`${cell(field)} text-right tabular-nums`}
      value={typed[field]}
      onChange={(event) => change({ [field]: event.target.value })}
      onBlur={() => saver?.flushNow()}
      data-testid={testId}
    />
  );
  const named = typed.pick === WORKSHOP_PICK ? WORKSHOP_LABEL : typed.customerName.trim();

  return (
    <li
      className={`py-1.5 ${status === 'draft' || status === 'failed' ? 'bg-amber-eje-50/50' : ''}`}
      data-testid="timesheet-line"
      data-line-id={line.id}
      data-date={line.date ?? ''}
      data-state={status}
    >
      {day === undefined && (
        <div className="mb-1.5 w-48">
          <TextField
            label="Date"
            type="date"
            value={date}
            error={problemOf('date')}
            // Kept here while it is typed (a browser reports partial years such as 0002-…); saved once the field is left,
            // so the line never jumps to another day, or out of the period, mid-typing.
            onChange={(event) => {
              latest.current = { ...latest.current, date: event.target.value };
              setDate(event.target.value);
            }}
            onBlur={(event) => {
              change({}, event.target.value);
              saver?.flushNow();
            }}
            data-testid="timesheet-line-date"
          />
        </div>
      )}
      {/* Customer | OT | D/T | Callout | Int Km | Cust Km — side by side; the day's header names the columns. */}
      <div className={TIMESHEET_ROW_GRID}>
        <input
          aria-label={`Customer${which}`}
          aria-invalid={problemOf('customer') !== undefined}
          list="timesheet-customer-options"
          autoComplete="off"
          maxLength={200}
          placeholder="Customer, site or Workshop"
          className={cell('customer')}
          value={customerShown}
          onChange={(event) => typeCustomer(event.target.value)}
          onBlur={() => saver?.flushNow()}
          data-testid="timesheet-customer-name"
        />
        {number('OT (hours)', 'overtime', 'timesheet-overtime')}
        {number('D/T (hours)', 'double', 'timesheet-double')}
        {number('Callout (R)', 'callout', 'timesheet-callout')}
        {number('Int Km', 'internalKm', 'timesheet-internal-km')}
        {number('Cust Km', 'customerKm', 'timesheet-customer-km')}
        <div className="flex items-center justify-end gap-1">
          <span className="w-14 text-right text-xs" data-testid="timesheet-line-status" role="status" aria-live="polite">
            {status === 'saving' && <span className="text-steel-600">Saving…</span>}
            {status === 'saved' && <span className="text-verdant-700">Saved</span>}
            {status === 'failed' && <span className="font-medium text-signal-600">Failed</span>}
            {status === 'draft' && <span className="font-medium text-amber-eje-700">Draft</span>}
          </span>
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Remove line${position === undefined ? '' : ` ${position}`}${named.length > 0 ? ` (${named})` : ''}`}
            onClick={() => setRemoving(true)}
            data-testid="remove-timesheet-line"
          >
            <Icon name="trash" className="size-4" />
          </Button>
        </div>
      </div>
      {status === 'failed' && <p className="mt-1 text-xs font-medium text-signal-600">Save failed — {pending?.refused}</p>}
      {status === 'draft' && problems.length === 0 && <p className="mt-1 text-xs text-amber-eje-700">Draft — saved, not complete yet.</p>}
      {(line.historical.normalHours > 0 || line.historical.callouts > 0) && (
        <p className="mt-1 text-xs text-steel-500">
          Entered before 28 October 2026 with{line.historical.normalHours > 0 ? ` NT ${line.historical.normalHours.toFixed(2)} h` : ''}
          {line.historical.callouts > 0 ? ` ${line.historical.callouts} call-out(s)` : ''} — kept as it was.
        </p>
      )}
      {problems.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-xs text-amber-eje-700" data-testid="timesheet-line-problems">
          {problems.map((problem) => <li key={problem.message}>{problem.message}</li>)}
        </ul>
      )}
      <ConfirmDialog
        open={removing}
        title="Remove this line?"
        message={`${named.length > 0 ? named : 'This line'}${date === '' ? '' : ` on ${formatDayAndDate(date)}`} is removed from your timesheet. The day's other lines stay as they are.`}
        confirmLabel="Remove line"
        confirmVariant="danger"
        onCancel={() => setRemoving(false)}
        onConfirm={() => {
          setRemoving(false);
          saver?.change({ kind: 'remove', id: line.id });
        }}
      />
    </li>
  );
};

/** The six columns and the line's own state and Remove, side by side; on a phone the day's table scrolls sideways. */
export const TIMESHEET_ROW_GRID = 'grid grid-cols-[minmax(10rem,2.2fr)_repeat(5,minmax(4.25rem,1fr))_6.5rem] items-center gap-1.5';

/** The column names over a day's lines, aligned with `TIMESHEET_ROW_GRID`. */
export const TimesheetLineHeader = () => (
  <div className={`${TIMESHEET_ROW_GRID} border-b border-steel-200 pb-1 text-xs font-semibold text-steel-600`} data-testid="timesheet-columns">
    <span>Customer</span>
    <span className="text-right">OT</span>
    <span className="text-right">D/T</span>
    <span className="text-right">Callout (R)</span>
    <span className="text-right">Int Km</span>
    <span className="text-right">Cust Km</span>
    <span className="sr-only">State and remove</span>
  </div>
);
