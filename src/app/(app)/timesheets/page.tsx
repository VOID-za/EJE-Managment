'use client';

import { useEffect, useMemo, useState } from 'react';
import { userFullName, type TimesheetEntry } from '@/domain';
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
  TextField,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { DownloadFileButton } from '@/components/exports/DownloadFileButton';
import { reads, timesheets } from '@/api/endpoints';
import type { TimesheetDay } from '@/application/timesheets';
import { useQuery } from '@/hooks/useQuery';
import { useOperation } from '@/hooks/useOperation';
import { useCurrentUser } from '@/providers/AppProvider';
import { businessToday } from '@/lib/business-time';
import { formatDate } from '@/lib/format';

const hours = (value: number): string => value.toFixed(2);

/** A line being typed: strings, exactly as the technician typed them. */
interface Draft {
  readonly entryId?: string;
  readonly date: string;
  readonly customerId: string;
  readonly customerName: string;
  readonly normal: string;
  readonly overtime: string;
  readonly double: string;
  readonly callouts: string;
}

const emptyDraft = (date: string): Draft => ({
  date,
  customerId: '',
  customerName: '',
  normal: '0',
  overtime: '0',
  double: '0',
  callouts: '0',
});

const draftOf = (entry: TimesheetEntry): Draft => ({
  entryId: entry.id,
  date: entry.date,
  customerId: entry.customerId ?? '',
  customerName: entry.customerName,
  normal: String(entry.normalHours),
  overtime: String(entry.overtimeHours),
  double: String(entry.doubleHours),
  callouts: String(entry.callouts),
});

const parse = (value: string): number => Number.parseFloat(value.replace(',', '.'));

/**
 * TECHNICIAN TIMESHEETS — COMPLETELY MANUAL. TIMESHEET-2 (27 October 2026).
 *
 * Every value on this sheet is one the technician typed: the customer, normal
 * time (NT), overtime (OT), double time (DBL T), call-outs and the day's
 * comment. Nothing is read from job cards, assignments or labour, and nothing
 * is prefilled or recalculated. A technician fills it in day by day, or all at
 * once later — the same form either way. A day with no line says NOT RECORDED;
 * a line of zeros is a recorded day with no hours.
 *
 * Only the technician enters their own sheet; the office opens anybody's and
 * exports it.
 */
const TimesheetsPage = () => {
  const currentUser = useCurrentUser();
  const operation = useOperation();
  const today = businessToday();
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [chosen, setChosen] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [removing, setRemoving] = useState<TimesheetEntry | null>(null);
  const [editingComment, setEditingComment] = useState<{ date: string; text: string } | null>(null);

  const people = useQuery(`timesheets:people:${currentUser.id}`, () => timesheets.people());
  const personId = chosen ?? people.data?.[0]?.id ?? null;
  const sheet = useQuery(`timesheets:${personId ?? 'none'}:${from}:${to}`, () =>
    personId === null ? Promise.resolve(null) : timesheets.sheet(personId, from, to),
  );
  const customers = useQuery('timesheets:customers', () => reads.customers());

  // Newest day first: a technician filling in today sees today at the top.
  const days = useMemo(() => [...(sheet.data?.days ?? [])].reverse(), [sheet.data]);
  const editable = sheet.data?.editable === true;

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

  const edit = (next: Draft | null) => {
    setDraft(next);
    setDirty(next !== null);
    operation.clearError();
  };

  const saveDraft = async (): Promise<void> => {
    if (personId === null || draft === null) return;
    const ok = await operation.run(async () => {
      await timesheets.saveEntry(personId, {
        ...(draft.entryId === undefined ? {} : { entryId: draft.entryId }),
        date: draft.date,
        customerId: draft.customerId.length > 0 ? draft.customerId : null,
        customerName: draft.customerName,
        normalHours: parse(draft.normal),
        overtimeHours: parse(draft.overtime),
        doubleHours: parse(draft.double),
        callouts: Number(draft.callouts),
      });
    });
    if (ok) {
      edit(null);
      sheet.refetch();
    }
  };

  const remove = async (): Promise<void> => {
    if (personId === null || removing === null) return;
    const ok = await operation.run(async () => {
      await timesheets.removeEntry(personId, removing.id);
    });
    setRemoving(null);
    if (ok) sheet.refetch();
  };

  const saveComment = async (date: string, text: string): Promise<void> => {
    if (personId === null) return;
    const ok = await operation.run(async () => {
      await timesheets.saveComment(personId, date, text);
    });
    if (ok) {
      setEditingComment(null);
      setDirty(false);
      sheet.refetch();
    }
  };

  const customerOptions = [
    { value: '', label: 'Type the customer below…' },
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
          label="Customer (from the register)"
          value={current.customerId}
          options={customerOptions}
          onChange={(event) => {
            const picked = (customers.data ?? []).find((customer) => customer.id === event.target.value);
            edit({ ...current, customerId: event.target.value, customerName: picked?.name ?? current.customerName });
          }}
        />
        <TextField
          label="Customer"
          value={current.customerName}
          maxLength={200}
          hint="Required when there are hours or a call-out."
          onChange={(event) => edit({ ...current, customerName: event.target.value })}
        />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <TextField label="NT (hours)" inputMode="decimal" value={current.normal} onChange={(event) => edit({ ...current, normal: event.target.value })} />
        <TextField label="OT (hours)" inputMode="decimal" value={current.overtime} onChange={(event) => edit({ ...current, overtime: event.target.value })} />
        <TextField label="DBL T (hours)" inputMode="decimal" value={current.double} onChange={(event) => edit({ ...current, double: event.target.value })} />
        <TextField label="Call-outs" inputMode="numeric" value={current.callouts} onChange={(event) => edit({ ...current, callouts: event.target.value })} />
      </div>
      <p className="text-xs text-steel-500">Hours in quarter hours (0.25 = 15 minutes). A line of zeros records a day with no hours.</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" loading={operation.running} onClick={() => void saveDraft()} data-testid="save-timesheet-line">
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
          <span className="font-semibold text-steel-900">{formatDate(day.date)}</span>
          {day.recorded ? (
            <Badge tone="green" size="sm">Recorded</Badge>
          ) : (
            <Badge tone="amber" size="sm">Not recorded</Badge>
          )}
          {day.attendance !== null && (
            <Badge tone="outline" size="sm">{day.attendance === 'present' ? 'Present' : 'Absent'}</Badge>
          )}
        </div>
        {editable && draft === null && (
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
                <th className="py-1 pr-3 text-right">NT</th>
                <th className="py-1 pr-3 text-right">OT</th>
                <th className="py-1 pr-3 text-right">DBL T</th>
                <th className="py-1 pr-3 text-right">Call-out</th>
                {editable && <th className="py-1" />}
              </tr>
            </thead>
            <tbody>
              {day.entries.map((entry) => (
                <tr key={entry.id} className="border-t border-steel-100" data-testid="timesheet-line">
                  <td className="py-1.5 pr-3">{entry.customerName || '—'}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{hours(entry.normalHours)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{hours(entry.overtimeHours)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{hours(entry.doubleHours)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{entry.callouts}</td>
                  {editable && (
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

      <div className="mt-2 text-sm">
        {editingComment !== null && editingComment.date === day.date ? (
          <div className="flex flex-wrap items-end gap-2">
            <TextField
              label={`Comment for ${day.date}`}
              value={editingComment.text}
              maxLength={1000}
              onChange={(event) => {
                setEditingComment({ date: day.date, text: event.target.value });
                setDirty(true);
              }}
              containerClassName="min-w-64 flex-1"
            />
            <Button size="sm" loading={operation.running} onClick={() => void saveComment(day.date, editingComment.text)} data-testid="save-timesheet-comment">
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setEditingComment(null); setDirty(false); }}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex items-start gap-2">
            <span className="flex-1 whitespace-pre-wrap text-steel-700" data-testid="timesheet-comment">
              {day.comment}
            </span>
            <Button size="sm" variant="ghost" onClick={() => setEditingComment({ date: day.date, text: day.comment })}>
              {day.comment.length > 0 ? 'Edit comment' : 'Add comment'}
            </Button>
          </div>
        )}
      </div>
    </li>
  );

  return (
    <>
      <PageHeader
        title="Timesheets"
        description="Each technician keeps their own timesheet: the customer, NT, OT, DBL T and call-outs, entered by hand for each day — as you go, or all at once later."
      />

      <ConfirmDialog
        open={removing !== null}
        title="Remove this line?"
        message={removing === null ? '' : `${removing.customerName || 'This line'} on ${removing.date} will be removed from your timesheet. The removal is recorded.`}
        confirmLabel="Remove line"
        confirmVariant="danger"
        busy={operation.running}
        onConfirm={() => void remove()}
        onCancel={() => setRemoving(null)}
      />

      <Card className="mb-5">
        <div className="flex flex-wrap items-end gap-4">
          {people.data.length > 1 ? (
            <SelectField
              label="Technician"
              value={personId ?? ''}
              onChange={(event) => setChosen(event.target.value)}
              options={people.data.map((person) => ({ value: person.id, label: userFullName(person) }))}
              containerClassName="w-64"
            />
          ) : (
            <div className="text-sm">
              <p className="mb-1.5 font-medium text-steel-700">Technician</p>
              <p className="font-semibold text-steel-900">{userFullName(people.data[0]!)}</p>
            </div>
          )}
          <TextField label="From" type="date" value={from} onChange={(event) => event.target.value.length > 0 && setFrom(event.target.value)} containerClassName="w-44" />
          <TextField label="To" type="date" value={to} onChange={(event) => event.target.value.length > 0 && setTo(event.target.value)} containerClassName="w-44" />
          {personId !== null && sheet.data !== null && sheet.data !== undefined && (
            <DownloadFileButton href={timesheets.exportUrl(personId, from, to)} fallbackName={`timesheet-${from}-${to}.csv`} label="Export CSV" />
          )}
        </div>
        <p className="mt-3 text-xs text-steel-500">
          {editable
            ? 'Add a line for each customer you worked for on a day. You can correct or remove your own lines at any time; every change is recorded.'
            : 'This is the technician’s own timesheet. Only they enter and correct it; the office reads and exports it.'}
        </p>
        {operation.error !== null && (
          <p role="alert" className="mt-2 text-sm font-medium text-signal-600">
            {operation.error}
          </p>
        )}
      </Card>

      {sheet.error !== null ? (
        <QueryFailure code={sheet.errorCode} message={sheet.error} onRetry={sheet.refetch} />
      ) : sheet.loading || sheet.data === null || sheet.data === undefined ? (
        <LoadingPanel rows={6} label="Loading the timesheet" />
      ) : (
        <>
          <Card className="mb-5">
            <div className="flex flex-wrap gap-6 text-sm" data-testid="timesheet-totals">
              <span>NT <strong className="tabular-nums">{hours(sheet.data.totals.normalHours)}</strong></span>
              <span>OT <strong className="tabular-nums">{hours(sheet.data.totals.overtimeHours)}</strong></span>
              <span>DBL T <strong className="tabular-nums">{hours(sheet.data.totals.doubleHours)}</strong></span>
              <span>Call-outs <strong className="tabular-nums">{sheet.data.totals.callouts}</strong></span>
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
