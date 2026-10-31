'use client';

import { useEffect, useRef, useState } from 'react';
import { WORKSHOP_LABEL } from '@/domain';
import { Button, SelectField, TextField } from '@/components/ui';
import { lineDateProblem } from '@/lib/timesheet-dates';
import {
  WORKSHOP_PICK,
  keepTimesheetDraft,
  timesheetDraftProblems,
  type TimesheetDraft,
} from '@/lib/timesheet-line';

const hours = (value: number): string => value.toFixed(2);

/**
 * ONE TIMESHEET LINE BEING ENTERED OR CORRECTED. TST-TS-2 (the tester,
 * 31 October 2026: "the Timesheets function is still broken when users fill
 * it in").
 *
 * WHY THIS IS ITS OWN COMPONENT. The line used to be state of the whole
 * Timesheets page, so every key pressed in any of its fields re-rendered every
 * day of the period with its table of lines. With a month entered that was
 * about 100 ms a key on a desktop and 450–580 ms on a slow tablet (measured
 * at 6× CPU throttling): letters arrived late, in bursts, and the form felt
 * frozen. The typed values now live HERE; a key re-renders this form only.
 *
 * The page keeps a copy of the line (`onChange`, into a ref, which costs it no
 * render): Save and Send to office save the open line first from it, and the
 * form starts from it (`initial`) if it is ever drawn in a different place.
 *
 * WHAT IS WRONG IS SAID HERE, beside the field and the button that was
 * pressed — never only in the period card at the top of the page, off screen
 * (`timesheetDraftProblems`; the server asks the same questions again).
 */
export const TimesheetLineForm = ({
  initial,
  onChange,
  storageKey,
  from,
  to,
  today,
  customers,
  customersLoading,
  onSave,
  onCancel,
  onDirtyChange,
}: {
  /** The line to start from, read once when the form is drawn. */
  readonly initial: () => TimesheetDraft;
  /** Every change, for the page's copy. */
  readonly onChange: (draft: TimesheetDraft) => void;
  /** Where this device keeps the open line; null keeps nothing. */
  readonly storageKey: string | null;
  readonly from: string;
  readonly to: string;
  readonly today: string;
  readonly customers: readonly { readonly id: string; readonly name: string }[];
  readonly customersLoading: boolean;
  /** Saves the line; the refusal's words, or null when it was saved. */
  readonly onSave: (draft: TimesheetDraft) => Promise<string | null>;
  readonly onCancel: () => void;
  /** Told only when the form goes from untouched to changed (once), never per key. */
  readonly onDirtyChange: (dirty: boolean) => void;
}) => {
  const [draft, setDraft] = useState<TimesheetDraft>(initial);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  // Field problems are shown once the person has tried to save, or left a field.
  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set());
  const dirty = useRef(false);
  const first = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Opening a line brings it into view, so a line opened low on a phone is
    // not hidden under the keyboard or below the fold.
    first.current?.scrollIntoView({ block: 'nearest' });
  }, []);

  const change = (next: TimesheetDraft) => {
    onChange(next);
    setDraft(next);
    setRefusal(null);
    if (storageKey !== null) keepTimesheetDraft(storageKey, next);
    if (!dirty.current) {
      dirty.current = true;
      onDirtyChange(true);
    }
  };
  const touch = (field: string) => setShown((current) => (current.has(field) ? current : new Set(current).add(field)));

  const dateProblem = lineDateProblem(draft.date, from, to, today);
  const problems = timesheetDraftProblems(draft);
  const problemOf = (field: keyof typeof problems) => (shown.has(field) || shown.has('*') ? problems[field] : undefined);

  const save = async () => {
    setShown(new Set(['*']));
    if (dateProblem !== null) return;
    if (Object.keys(problems).length > 0) {
      setRefusal('Put right what is marked above, then press Save line again.');
      return;
    }
    setSaving(true);
    const refused = await onSave(draft);
    // The page closes the form when the line was saved; nothing to do then.
    if (refused !== null) {
      setSaving(false);
      setRefusal(refused);
    }
  };

  const customerOptions = [
    { value: '', label: customersLoading ? 'Loading customers…' : 'Type the customer below…' },
    { value: WORKSHOP_PICK, label: WORKSHOP_LABEL },
    ...customers.map((customer) => ({ value: customer.id, label: customer.name })),
  ];

  const number = (label: string, field: 'overtime' | 'double' | 'callout' | 'internalKm' | 'customerKm', testId?: string) => (
    <TextField
      label={label}
      inputMode="decimal"
      autoComplete="off"
      value={draft[field]}
      error={problemOf(field)}
      onChange={(event) => change({ ...draft, [field]: event.target.value })}
      onBlur={() => touch(field)}
      {...(testId === undefined ? {} : { 'data-testid': testId })}
    />
  );

  return (
    <div
      ref={first}
      className="mt-2 scroll-mt-24 space-y-3 rounded-[var(--radius-control)] border border-eje-200 bg-eje-50/40 p-3"
      data-testid="timesheet-line-form"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TextField
          label="Date"
          type="date"
          value={draft.date}
          min={from}
          max={to < today ? to : today}
          error={dateProblem ?? undefined}
          onChange={(event) => change({ ...draft, date: event.target.value })}
          data-testid="timesheet-line-date"
        />
        <SelectField
          label="Customer or Workshop"
          value={draft.pick}
          options={customerOptions}
          data-testid="timesheet-customer-pick"
          onChange={(event) => {
            const value = event.target.value;
            const picked = customers.find((customer) => customer.id === value);
            change({
              ...draft,
              pick: value,
              customerName: value === WORKSHOP_PICK ? '' : picked?.name ?? (draft.pick === WORKSHOP_PICK ? '' : draft.customerName),
            });
          }}
        />
        {draft.pick !== WORKSHOP_PICK && (
          <TextField
            label="Customer"
            value={draft.customerName}
            maxLength={200}
            autoComplete="off"
            error={problemOf('customer')}
            hint="Required when there are hours, a call-out or kilometres — or choose Workshop."
            onChange={(event) => change({ ...draft, customerName: event.target.value })}
            onBlur={() => touch('customer')}
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
      <label className="flex min-h-11 items-center gap-2 text-sm text-steel-700">
        <input
          type="checkbox"
          checked={draft.calloutShared}
          onChange={(event) => change({ ...draft, calloutShared: event.target.checked })}
          className="size-4.5 shrink-0 rounded border-steel-300 text-eje-600 focus:ring-eje-500"
          data-testid="timesheet-callout-shared"
        />
        Shared call-out — enter only YOUR share (e.g. R500 of a R1 000 call-out shared by two). Nothing is divided for you.
      </label>
      {(draft.keepNormal ?? 0) > 0 && (
        <p className="text-xs text-steel-500">
          This line was entered before 28 October 2026 with NT {hours(draft.keepNormal ?? 0)} h. NT is no longer recorded; it is kept as it was.
        </p>
      )}
      <p className="text-xs text-steel-500">Hours in quarter hours (0.25 = 15 minutes). Kilometres to one decimal.</p>
      {refusal !== null && (
        <p role="alert" className="text-sm font-medium text-signal-600" data-testid="timesheet-line-refusal">
          {refusal}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {/* A date still being typed is not a date: Save waits for the whole of it (the 30 October freeze). */}
        <Button size="sm" loading={saving} disabled={dateProblem !== null} onClick={() => void save()} data-testid="save-timesheet-line">
          Save line
        </Button>
        <Button size="sm" variant="ghost" disabled={saving} onClick={onCancel} data-testid="cancel-timesheet-line">
          Cancel
        </Button>
      </div>
    </div>
  );
};
