'use client';

import { useEffect, useState } from 'react';
import { ABSENCE_REASON_LABELS, WORKSHOP_LABEL, can, userFullName, type TimesheetEntry } from '@/domain';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Icon,
  LoadingPanel,
  QueryFailure,
  SelectField,
  TextAreaField,
  TextField,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { DownloadFileButton } from '@/components/exports/DownloadFileButton';
import { DocumentPreviewDialog } from '@/components/documents/DocumentPreviewDialog';
import { TimesheetDocumentView } from '@/components/timesheets/TimesheetDocumentView';
import { TimesheetCorrections } from '@/components/timesheets/TimesheetCorrections';
import { reads, timesheets } from '@/api/endpoints';
import { TIMESHEET_MAX_DAYS, type TimesheetDay, type TimesheetDocument } from '@/application/timesheets';
import { useQuery } from '@/hooks/useQuery';
import { useOperation } from '@/hooks/useOperation';
import { useCurrentUser } from '@/providers/AppProvider';
import { businessToday } from '@/lib/business-time';
import { formatCurrency, formatDateTime } from '@/lib/format';
import {
  defaultTimesheetRange,
  formatDayAndDate,
  formatPeriod,
  timesheetRangeProblem,
} from '@/lib/timesheet-dates';

const hours = (value: number): string => value.toFixed(2);
const kilometres = (value: number): string => value.toFixed(1);

/** The customer picker's value for Workshop: not a customer id, never sent as one. */
const WORKSHOP = '__workshop__';

/** A line being typed: strings, exactly as the technician typed them. */
interface Draft {
  readonly entryId?: string;
  readonly date: string;
  /** A customer id, WORKSHOP, or '' for a typed name. */
  readonly pick: string;
  readonly customerName: string;
  readonly overtime: string;
  readonly double: string;
  /** Rand, as typed ("450" or "450.00"). */
  readonly callout: string;
  readonly calloutShared: boolean;
  readonly internalKm: string;
  readonly customerKm: string;
  /** An older line's NT and call-out count, carried back unchanged (TS-07/08). */
  readonly keepNormal?: number;
  readonly keepCallouts?: number;
}

const emptyDraft = (date: string): Draft => ({
  date,
  pick: '',
  customerName: '',
  overtime: '0',
  double: '0',
  callout: '0',
  calloutShared: false,
  internalKm: '0',
  customerKm: '0',
});

const draftOf = (entry: TimesheetEntry): Draft => ({
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
/** Rand as typed, to whole cents. NaN stays NaN so the server refuses it. */
const toCents = (value: string): number => Math.round(parse(value) * 100);

/**
 * TECHNICIAN TIMESHEETS. TIMESHEET-2 (27 October 2026), reshaped by the
 * real-world reviewer on 28 October 2026 (TS-01 … TS-14).
 *
 * Each technician keeps their own: for each day, the customer — or Workshop —
 * overtime (OT), double time (DT), the call-out as a rand amount (marked shared
 * when several jobs share it), internal and customer kilometres. NT is no
 * longer entered; older lines keep theirs, shown as historical.
 *
 * THE FROM AND TO DATES ARE THE TIMESHEET PERIOD (the owner, 28 October 2026).
 * The page opens on the 1st of this month to today, OLDEST DAY FIRST — the two
 * boxes reset on every visit; saved lines are never touched by that. The
 * period's one comment, Preview, Save, Print and Send to office act on exactly
 * those dates: Send to office makes that period read-only, the office is
 * notified and reads the version that was sent. A period that shares a day
 * with one already sent cannot be sent, so no work is sent twice.
 *
 * A SENT TIMESHEET IS CORRECTED, NOT EDITED (TS-16): its technician asks for a
 * correction; the office accepts or rejects it. The office sees the
 * corrections waiting for it at the top of this page.
 */
const TimesheetsPage = () => {
  const currentUser = useCurrentUser();
  const operation = useOperation();
  const today = businessToday();
  // Reset on every visit (TS-04): plain state, deliberately not remembered.
  const initial = defaultTimesheetRange(today);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [chosen, setChosen] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [removing, setRemoving] = useState<TimesheetEntry | null>(null);
  const [comment, setComment] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<'preview' | 'print' | null>(null);
  const [confirmSend, setConfirmSend] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const rangeProblem = timesheetRangeProblem(from, to, TIMESHEET_MAX_DAYS);
  const people = useQuery(`timesheets:people:${currentUser.id}`, () => timesheets.people());
  const personId = chosen ?? people.data?.[0]?.id ?? null;
  const sheet = useQuery(`timesheets:${personId ?? 'none'}:${from}:${to}`, () =>
    personId === null || rangeProblem !== null ? Promise.resolve(null) : timesheets.sheet(personId, from, to),
  );
  const periodDocument = useQuery(`timesheets:document:${personId ?? 'none'}:${from}:${to}`, () =>
    personId === null || rangeProblem !== null ? Promise.resolve(null) : timesheets.document(personId, from, to),
  );
  const customers = useQuery('timesheets:customers', () => reads.customers());
  const reviewer = can(currentUser.role, 'timesheets.reviewCorrections');
  const pendingCorrections = useQuery(`timesheets:corrections:pending:${currentUser.id}`, () =>
    reviewer ? timesheets.pendingCorrections() : Promise.resolve([]),
  );

  // OLDEST DAY FIRST (TS-04): the first entries of the range are at the top.
  const days = sheet.data?.days ?? [];
  const editable = sheet.data?.editable === true;
  const period = sheet.data?.period ?? null;
  const sentAt = period?.submittedAt ?? null;
  const overlapsSent = period?.overlapsSent ?? [];
  // Save and Send act on a period that has ended, was not sent, and shares no
  // day with one that was. The server asks the same questions.
  const periodOpen = editable && sentAt === null && overlapsSent.length === 0 && to <= today;
  const savedComment = period?.comment ?? '';
  const commentValue = comment ?? savedComment;
  const showHistoricalNt = days.some((day) => day.normalHours > 0);
  const showHistoricalCount = days.some((day) => day.callouts > 0);

  /*
   * NOTHING TYPED IS LOST BY LEAVING. A line half-typed, or a comment being
   * written, warns before the page is closed or reloaded.
   */
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (people.error !== null) {
    return <QueryFailure code={people.errorCode} message={people.error} onRetry={people.refetch} />;
  }
  if (people.loading || people.data === null || people.data === undefined) {
    return <LoadingPanel rows={4} label="Loading timesheets" />;
  }
  if (people.data.length === 0) {
    return (
      <EmptyState
        title="No technicians yet"
        description="Timesheets appear here once technicians are on the system."
        icon={<Icon name="clock" />}
      />
    );
  }

  const refresh = () => {
    sheet.refetch();
    periodDocument.refetch();
    pendingCorrections.refetch();
  };

  const edit = (next: Draft | null) => {
    setDraft(next);
    setDirty(next !== null || comment !== null);
    setSaved(null);
    operation.clearError();
  };

  const saveLine = async (): Promise<boolean> => {
    if (personId === null || draft === null) return true;
    const workshop = draft.pick === WORKSHOP;
    const ok = await operation.run(async () => {
      await timesheets.saveEntry(personId, {
        ...(draft.entryId === undefined ? {} : { entryId: draft.entryId }),
        date: draft.date,
        customerId: workshop || draft.pick.length === 0 ? null : draft.pick,
        customerName: workshop ? '' : draft.customerName,
        workshop,
        ...(draft.keepNormal === undefined ? {} : { normalHours: draft.keepNormal }),
        ...(draft.keepCallouts === undefined ? {} : { callouts: draft.keepCallouts }),
        overtimeHours: parse(draft.overtime),
        doubleHours: parse(draft.double),
        calloutAmount: toCents(draft.callout),
        calloutShared: draft.calloutShared,
        internalKm: parse(draft.internalKm),
        customerKm: parse(draft.customerKm),
      });
    });
    // On a refusal the form stays open with every value as typed (TS-12).
    if (ok) {
      setDraft(null);
      setDirty(comment !== null);
    }
    return ok;
  };

  /** SAVE (TS-12): the open line, if any, and the period's comment. Never a submission. */
  const save = async (): Promise<void> => {
    if (personId === null) return;
    const lineOk = await saveLine();
    if (!lineOk) return;
    if (comment !== null && comment !== savedComment) {
      const ok = await operation.run(async () => {
        await timesheets.savePeriodComment(personId, from, to, comment);
      });
      if (!ok) return;
    }
    setComment(null);
    setDirty(false);
    setSaved(`Saved ${formatDateTime(new Date().toISOString())}. Not sent to the office.`);
    refresh();
  };

  const remove = async (): Promise<void> => {
    if (personId === null || removing === null) return;
    const ok = await operation.run(async () => {
      await timesheets.removeEntry(personId, removing.id);
    });
    setRemoving(null);
    if (ok) refresh();
  };

  /** SEND TO OFFICE (TS-02, TS-14): saves first, then sends the period once. */
  const send = async (): Promise<void> => {
    if (personId === null) return;
    setConfirmSend(false);
    const lineOk = await saveLine();
    if (!lineOk) return;
    const ok = await operation.run(async () => {
      if (comment !== null && comment !== savedComment) await timesheets.savePeriodComment(personId, from, to, comment);
      await timesheets.submit(personId, from, to);
    });
    if (ok) {
      setComment(null);
      setDirty(false);
      setSaved(null);
    }
    refresh();
  };

  const customerOptions = [
    { value: '', label: 'Type the customer below…' },
    { value: WORKSHOP, label: WORKSHOP_LABEL },
    ...(customers.data ?? []).map((customer) => ({ value: customer.id, label: customer.name })),
  ];

  const lineForm = (current: Draft) => (
    <div className="mt-2 space-y-3 rounded-[var(--radius-control)] border border-eje-200 bg-eje-50/40 p-3" data-testid="timesheet-line-form">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TextField
          label="Date"
          type="date"
          value={current.date}
          max={today}
          onChange={(event) => edit({ ...current, date: event.target.value })}
        />
        <SelectField
          label="Customer or Workshop"
          value={current.pick}
          options={customerOptions}
          data-testid="timesheet-customer-pick"
          onChange={(event) => {
            const value = event.target.value;
            const picked = (customers.data ?? []).find((customer) => customer.id === value);
            edit({
              ...current,
              pick: value,
              customerName: value === WORKSHOP ? '' : picked?.name ?? (current.pick === WORKSHOP ? '' : current.customerName),
            });
          }}
        />
        {current.pick !== WORKSHOP && (
          <TextField
            label="Customer"
            value={current.customerName}
            maxLength={200}
            hint="Required when there are hours, a call-out or kilometres — or choose Workshop."
            onChange={(event) => edit({ ...current, customerName: event.target.value })}
          />
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <TextField label="OT (hours)" inputMode="decimal" value={current.overtime} onChange={(event) => edit({ ...current, overtime: event.target.value })} />
        <TextField label="D/T (hours)" inputMode="decimal" value={current.double} onChange={(event) => edit({ ...current, double: event.target.value })} />
        <TextField label="Callout (R)" inputMode="decimal" value={current.callout} onChange={(event) => edit({ ...current, callout: event.target.value })} data-testid="timesheet-callout" />
        <TextField label="Int Km" inputMode="decimal" value={current.internalKm} onChange={(event) => edit({ ...current, internalKm: event.target.value })} />
        <TextField label="Cust Km" inputMode="decimal" value={current.customerKm} onChange={(event) => edit({ ...current, customerKm: event.target.value })} />
      </div>
      <label className="flex items-center gap-2 text-sm text-steel-700">
        <input
          type="checkbox"
          checked={current.calloutShared}
          onChange={(event) => edit({ ...current, calloutShared: event.target.checked })}
          className="size-4.5 rounded border-steel-300 text-eje-600 focus:ring-eje-500"
          data-testid="timesheet-callout-shared"
        />
        Shared call-out — enter only YOUR share (e.g. R500 of a R1 000 call-out shared by two). Nothing is divided for you.
      </label>
      {(current.keepNormal ?? 0) > 0 && (
        <p className="text-xs text-steel-500">
          This line was entered before 28 October 2026 with NT {hours(current.keepNormal ?? 0)} h. NT is no longer recorded; it is kept as it was.
        </p>
      )}
      <p className="text-xs text-steel-500">Hours in quarter hours (0.25 = 15 minutes). Kilometres to one decimal.</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" loading={operation.running} onClick={() => void saveLine().then((ok) => ok && refresh())} data-testid="save-timesheet-line">
          Save line
        </Button>
        <Button size="sm" variant="ghost" onClick={() => edit(null)}>
          Cancel
        </Button>
      </div>
    </div>
  );

  const dayRow = (day: TimesheetDay) => (
    <li
      key={day.date}
      className="py-3"
      data-testid="timesheet-day"
      data-date={day.date}
      data-recorded={day.recorded ? 'yes' : 'no'}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-steel-900" data-testid="timesheet-day-label">
            {formatDayAndDate(day.date)}
          </span>
          {day.recorded ? (
            <Badge tone="green" size="sm">Recorded</Badge>
          ) : (
            <Badge tone="amber" size="sm">Not recorded</Badge>
          )}
          {day.locked && (
            <span data-testid="timesheet-day-sent-version">
              <Badge tone="outline" size="sm">{day.sentVersion || 'Sent to office'}</Badge>
            </span>
          )}
          {day.attendance !== null && (
            <Badge tone="outline" size="sm">
              {day.attendance === 'present'
                ? 'Present'
                : day.absenceReason === null
                  ? 'Absent'
                  : `Absent — ${ABSENCE_REASON_LABELS[day.absenceReason]}`}
            </Badge>
          )}
        </div>
        {editable && !day.locked && draft === null && (
          <Button size="sm" variant="secondary" onClick={() => edit(emptyDraft(day.date))} data-testid="add-timesheet-line">
            <Icon name="plus" className="size-4" /> Add line
          </Button>
        )}
      </div>

      {day.entries.length > 0 && (
        <div className="eje-scrollbar mt-2 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-steel-500 uppercase">
                <th className="py-1 pr-3">Customer</th>
                <th className="py-1 pr-3 text-right">OT</th>
                <th className="py-1 pr-3 text-right">D/T</th>
                <th className="py-1 pr-3 text-right">Callout</th>
                <th className="py-1 pr-3 text-right">Int Km</th>
                <th className="py-1 pr-3 text-right">Cust Km</th>
                {showHistoricalNt && <th className="py-1 pr-3 text-right">NT (historical)</th>}
                {showHistoricalCount && <th className="py-1 pr-3 text-right">Call-outs (historical)</th>}
                {editable && !day.locked && <th className="py-1" />}
              </tr>
            </thead>
            <tbody>
              {day.entries.map((entry) => (
                <tr key={entry.id} className="border-t border-steel-100" data-testid="timesheet-line">
                  <td className="py-1.5 pr-3">{entry.workshop ? WORKSHOP_LABEL : entry.customerName || '—'}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{hours(entry.overtimeHours)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{hours(entry.doubleHours)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {formatCurrency(entry.calloutAmount)}
                    {entry.calloutShared && ' (shared)'}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{kilometres(entry.internalKm)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{kilometres(entry.customerKm)}</td>
                  {showHistoricalNt && <td className="py-1.5 pr-3 text-right tabular-nums text-steel-500">{entry.normalHours > 0 ? hours(entry.normalHours) : ''}</td>}
                  {showHistoricalCount && <td className="py-1.5 pr-3 text-right tabular-nums text-steel-500">{entry.callouts > 0 ? entry.callouts : ''}</td>}
                  {editable && !day.locked && (
                    <td className="py-1.5 text-right whitespace-nowrap">
                      <Button size="sm" variant="ghost" disabled={draft !== null} onClick={() => edit(draftOf(entry))}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" disabled={draft !== null} onClick={() => setRemoving(entry)}>
                        Remove
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {draft !== null && draft.date === day.date && lineForm(draft)}

      {day.comment.length > 0 && (
        <p className="mt-2 text-sm whitespace-pre-wrap text-steel-600" data-testid="timesheet-day-comment">
          <span className="text-xs font-semibold text-steel-500">Day comment (written before one comment per timesheet): </span>
          {day.comment}
        </p>
      )}
    </li>
  );

  return (
    <>
      <PageHeader
        title="Timesheets"
        description="Each technician keeps their own timesheet: the customer or Workshop, OT, D/T, the call-out amount and Int Km / Cust Km, entered by hand for each day — as you go, or all at once later."
      />

      <ConfirmDialog
        open={removing !== null}
        title="Remove this line?"
        message={removing === null ? '' : `${removing.workshop ? WORKSHOP_LABEL : removing.customerName || 'This line'} on ${removing.date} will be removed from your timesheet. The removal is recorded.`}
        confirmLabel="Remove line"
        confirmVariant="danger"
        busy={operation.running}
        onConfirm={() => void remove()}
        onCancel={() => setRemoving(null)}
      />

      <ConfirmDialog
        open={confirmSend}
        title={`Send the timesheet for ${formatPeriod(from, to)} to the office?`}
        message="It is saved first, then sent. Once sent you can no longer add, change or remove a line on any day in this period, or change the comment, and no other period may include these days. The office is notified and reads the version you sent."
        confirmLabel="Send to office"
        busy={operation.running}
        onConfirm={() => void send()}
        onCancel={() => setConfirmSend(false)}
      />

      {personId !== null && (
        <DocumentPreviewDialog
          open={previewing !== null}
          autoPrint={previewing === 'print'}
          title={`Time Sheet — ${formatPeriod(from, to)}`}
          description={sentAt === null ? 'Preview of the draft. Nothing is saved or sent by looking at it.' : `The version in force: ${period?.versionInForce ?? ''}.`}
          loadPdf={() => timesheets.pdf(personId, from, to)}
          renderHtml={() =>
            periodDocument.data === null || periodDocument.data === undefined ? null : (
              <TimesheetDocumentView document={periodDocument.data as TimesheetDocument} />
            )
          }
          onClose={() => setPreviewing(null)}
        />
      )}

      {reviewer && (pendingCorrections.data ?? []).length > 0 && (
        <Card className="mb-5" data-testid="timesheet-pending-corrections">
          <p className="text-sm font-semibold text-steel-900">Timesheet corrections waiting for you</p>
          <ul className="mt-2 divide-y divide-steel-100 text-sm">
            {(pendingCorrections.data ?? []).map((pending) => (
              <li key={pending.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <strong>{pending.technicianName}</strong> — {pending.periodLabel}, correction {pending.sequence}, asked for {formatDateTime(pending.requestedAt)}. Reason: {pending.reason}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setChosen(pending.technicianId);
                    setFrom(pending.from);
                    setTo(pending.to);
                    setComment(null);
                  }}
                  data-testid="timesheet-pending-open"
                >
                  Open
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="mb-5">
        <div className="flex flex-wrap items-end gap-4">
          {people.data.length > 1 ? (
            <SelectField
              label="Technician"
              value={personId ?? ''}
              onChange={(event) => {
                setChosen(event.target.value);
                // A comment being typed belongs to the sheet it was typed on.
                setComment(null);
              }}
              options={people.data.map((person) => ({ value: person.id, label: userFullName(person) }))}
              containerClassName="w-64"
            />
          ) : (
            <div className="text-sm">
              <p className="mb-1.5 font-medium text-steel-700">Technician</p>
              <p className="font-semibold text-steel-900">{userFullName(people.data[0]!)}</p>
            </div>
          )}
          <TextField label="From" type="date" value={from} onChange={(event) => setFrom(event.target.value)} containerClassName="w-44" data-testid="timesheet-from" />
          <TextField label="To" type="date" value={to} onChange={(event) => setTo(event.target.value)} containerClassName="w-44" data-testid="timesheet-to" />
          {personId !== null && rangeProblem === null && sheet.data !== null && sheet.data !== undefined && (
            <DownloadFileButton href={timesheets.exportUrl(personId, from, to)} fallbackName={`timesheet-${from}-${to}.csv`} label="Export CSV" />
          )}
        </div>
        {rangeProblem !== null && (
          <p role="alert" className="mt-2 text-sm font-medium text-signal-600" data-testid="timesheet-range-problem">
            {rangeProblem}
          </p>
        )}
        <p className="mt-3 text-xs text-steel-500">
          {editable
            ? 'Add a line for each customer — or Workshop — you worked for on a day. You can correct or remove your own lines until a period holding that day is sent to the office; every change is recorded.'
            : 'This is the technician’s own timesheet. Only they enter it; the office reads it, previews and prints it, and exports it.'}
        </p>
      </Card>

      {rangeProblem === null && period !== null && (
      <Card className="mb-5" data-testid="timesheet-period">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm font-semibold text-steel-900" data-testid="timesheet-period-label">
            Timesheet period: {period.label}
          </p>
          {sentAt === null ? (
            <Badge tone="amber" size="sm">Draft — not sent</Badge>
          ) : (
            <Badge tone="green" size="sm">
              Sent to office {formatDateTime(sentAt)}
              {period.submittedByName ? ` by ${period.submittedByName}` : ''}
            </Badge>
          )}
        </div>
        {sentAt === null && overlapsSent.length > 0 && (
          <p role="status" className="mt-2 text-sm text-amber-eje-700" data-testid="timesheet-period-overlap">
            Part of these dates was already sent to the office ({overlapsSent.map((sent) => formatPeriod(sent.from, sent.to)).join('; ')}). Choose From and To dates outside it to send a new period.
          </p>
        )}
        {sentAt === null && overlapsSent.length === 0 && to > today && editable && (
          <p role="status" className="mt-2 text-sm text-steel-600">A period can be sent once its To date has passed or is today.</p>
        )}
        <div className="mt-3">
          {periodOpen ? (
            <TextAreaField
              label={`Comments for ${period.label}`}
              value={commentValue}
              maxLength={2000}
              rows={3}
              hint="One comment for the whole timesheet. It is printed in the Comments box."
              onChange={(event) => {
                setComment(event.target.value);
                setDirty(true);
                setSaved(null);
              }}
              data-testid="timesheet-period-comment"
            />
          ) : (
            <div className="text-sm">
              <p className="mb-1 font-medium text-steel-700">Comments for {period.label}</p>
              <p className="whitespace-pre-wrap text-steel-800" data-testid="timesheet-period-comment-read">
                {savedComment.length > 0 ? savedComment : '—'}
              </p>
            </div>
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="secondary" leadingIcon={<Icon name="document" className="size-4" />} onClick={() => setPreviewing('preview')} data-testid="timesheet-preview">
            Preview
          </Button>
          {periodOpen && (
            <Button variant="secondary" loading={operation.running} onClick={() => void save()} data-testid="timesheet-save">
              Save
            </Button>
          )}
          <Button variant="secondary" leadingIcon={<Icon name="document" className="size-4" />} onClick={() => setPreviewing('print')} data-testid="timesheet-print">
            Print
          </Button>
          {periodOpen && (
            <Button onClick={() => setConfirmSend(true)} loading={operation.running} data-testid="timesheet-send">
              Send to office
            </Button>
          )}
        </div>
        {saved !== null && (
          <p role="status" className="mt-2 text-sm text-verdant-700" data-testid="timesheet-saved">
            {saved}
          </p>
        )}
        {operation.error !== null && (
          <p role="alert" className="mt-2 text-sm font-medium text-signal-600">
            {operation.error}
          </p>
        )}
        <p className="mt-2 text-xs text-steel-500">
          Preview and Print show the Time Sheet for these dates exactly as it prints, and change nothing. Send to office is once per period; after that its days are read-only, and a mistake is put right by a correction the office accepts.
        </p>
        {sentAt !== null && personId !== null && (
          <TimesheetCorrections
            user={currentUser}
            personId={personId}
            period={period}
            entries={days.flatMap((day) => day.entries)}
            owner={editable}
            customers={customers.data ?? []}
            onChanged={refresh}
          />
        )}
      </Card>
      )}

      {rangeProblem !== null ? null : sheet.error !== null ? (
        <QueryFailure code={sheet.errorCode} message={sheet.error} onRetry={sheet.refetch} />
      ) : sheet.loading || sheet.data === null || sheet.data === undefined ? (
        <LoadingPanel rows={6} label="Loading the timesheet" />
      ) : (
        <>
          <Card className="mb-5">
            <div className="flex flex-wrap gap-6 text-sm" data-testid="timesheet-totals">
              <span>OT <strong className="tabular-nums">{hours(sheet.data.totals.overtimeHours)}</strong></span>
              <span>D/T <strong className="tabular-nums">{hours(sheet.data.totals.doubleHours)}</strong></span>
              <span>Callout <strong className="tabular-nums">{formatCurrency(sheet.data.totals.calloutAmount)}</strong></span>
              <span>Int Km <strong className="tabular-nums">{kilometres(sheet.data.totals.internalKm)}</strong></span>
              <span>Cust Km <strong className="tabular-nums">{kilometres(sheet.data.totals.customerKm)}</strong></span>
              {sheet.data.totals.normalHours > 0 && (
                <span className="text-steel-500">NT (historical) <strong className="tabular-nums">{hours(sheet.data.totals.normalHours)}</strong></span>
              )}
              <span>Recorded days <strong>{sheet.data.totals.recordedDays}</strong></span>
              <span className={sheet.data.totals.unrecordedDays > 0 ? 'text-amber-eje-700' : ''}>
                Not recorded <strong>{sheet.data.totals.unrecordedDays}</strong>
              </span>
            </div>
          </Card>
          <Card>
            <ul className="divide-y divide-steel-100" data-testid="timesheet-table">
              {days.map(dayRow)}
            </ul>
          </Card>
        </>
      )}
    </>
  );
};

export default TimesheetsPage;
