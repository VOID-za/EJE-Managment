'use client';

import { useMemo, useState } from 'react';
import { userFullName } from '@/domain';
import {
  Badge,
  Button,
  Card,
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
import { timesheets } from '@/api/endpoints';
import type { TimesheetRow } from '@/application/timesheets';
import { useQuery } from '@/hooks/useQuery';
import { useOperation } from '@/hooks/useOperation';
import { useCurrentUser } from '@/providers/AppProvider';
import { businessToday } from '@/lib/business-time';
import { formatDate } from '@/lib/format';

const hours = (value: number): string => (value === 0 ? '—' : value.toFixed(2));

/**
 * TECHNICIAN TIMESHEETS. TIMESHEET-1.
 *
 * Date, customer, normal time, OT, Dblt, call-out and the day's comment, for
 * one technician over a range. The hours are the technician's own labour lines
 * from the jobs — read, never copied — so this sheet and the job cards cannot
 * disagree. The office opens anybody's and exports it; a technician opens
 * their own. Either may write the day's comment on a sheet they can open.
 */
const TimesheetsPage = () => {
  const currentUser = useCurrentUser();
  const operation = useOperation();
  const today = businessToday();
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [chosen, setChosen] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ date: string; text: string } | null>(null);

  const people = useQuery(`timesheets:people:${currentUser.id}`, () => timesheets.people());
  const personId = chosen ?? people.data?.[0]?.id ?? null;
  const sheet = useQuery(`timesheets:${personId ?? 'none'}:${from}:${to}`, () =>
    personId === null ? Promise.resolve(null) : timesheets.sheet(personId, from, to),
  );

  const rows = useMemo(() => sheet.data?.rows ?? [], [sheet.data]);
  const dayCount = useMemo(() => new Set(rows.map((row) => row.date)).size, [rows]);

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

  const saveComment = async (date: string, text: string): Promise<void> => {
    if (personId === null) return;
    const ok = await operation.run(async () => {
      await timesheets.saveComment(personId, date, text);
    });
    if (ok) {
      setEditing(null);
      sheet.refetch();
    }
  };

  const commentCell = (row: TimesheetRow) => {
    if (!row.firstOfDay) return null;
    if (editing !== null && editing.date === row.date) {
      return (
        <div className="space-y-2">
          <TextAreaField
            label={`Comment for ${row.date}`}
            rows={2}
            maxLength={1000}
            value={editing.text}
            onChange={(event) => setEditing({ date: row.date, text: event.target.value })}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              loading={operation.running}
              onClick={() => void saveComment(row.date, editing.text)}
              data-testid="save-timesheet-comment"
            >
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </div>
      );
    }
    return (
      <div className="flex items-start gap-2">
        <span className="flex-1 whitespace-pre-wrap text-steel-700" data-testid="timesheet-comment">
          {row.comment}
        </span>
        {row.date <= today && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setEditing({ date: row.date, text: row.comment })}
            aria-label={`Comment on ${row.date}`}
          >
            {row.comment.length > 0 ? 'Edit' : 'Comment'}
          </Button>
        )}
      </div>
    );
  };

  return (
    <>
      <PageHeader
        title="Timesheets"
        description="Hours by day and customer, from the labour recorded on each job, with the day's comment."
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
          <TextField
            label="From"
            type="date"
            value={from}
            onChange={(event) => event.target.value.length > 0 && setFrom(event.target.value)}
            containerClassName="w-44"
          />
          <TextField
            label="To"
            type="date"
            value={to}
            onChange={(event) => event.target.value.length > 0 && setTo(event.target.value)}
            containerClassName="w-44"
          />
          {personId !== null && sheet.data !== null && sheet.data !== undefined && (
            <DownloadFileButton
              href={timesheets.exportUrl(personId, from, to)}
              fallbackName={`timesheet-${from}-${to}.csv`}
              label="Export CSV"
            />
          )}
        </div>
        <p className="mt-3 text-xs text-steel-500">
          <strong>Callout</strong> counts the jobs that carried the call-out fee, once per job, on
          the technician’s first day on that job. Hours are never entered here — correct them on the
          job, and the timesheet follows.
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
        <Card padded={false}>
          <div className="flex flex-wrap items-center gap-2 px-5 pt-4">
            <Badge tone="outline">{dayCount} {dayCount === 1 ? 'day' : 'days'}</Badge>
          </div>
          <div className="overflow-x-auto">
            <table className="mt-3 w-full text-sm" data-testid="timesheet-table">
              <thead>
                <tr className="border-b border-steel-200 text-left text-xs font-semibold tracking-wide text-steel-500 uppercase">
                  <th className="px-5 py-2">Date</th>
                  <th className="px-3 py-2">Customer</th>
                  <th className="px-3 py-2 text-right">Normal</th>
                  <th className="px-3 py-2 text-right">OT</th>
                  <th className="px-3 py-2 text-right">Dblt</th>
                  <th className="px-3 py-2 text-right">Callout</th>
                  <th className="px-3 py-2">Comments</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-5 py-6 text-center text-steel-500">
                      No labour or comments in this range.
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => (
                    <tr
                      key={`${row.date}|${row.customerId ?? 'none'}`}
                      className={row.firstOfDay ? 'border-t border-steel-200' : ''}
                      data-testid="timesheet-row"
                      data-date={row.date}
                    >
                      <td className="px-5 py-2 align-top whitespace-nowrap">
                        {row.firstOfDay && (
                          <>
                            <span className="font-medium text-steel-900">{formatDate(row.date)}</span>
                            {row.attendance !== null && (
                              <Badge
                                tone={row.attendance === 'present' ? 'green' : 'red'}
                                size="sm"
                                className="ml-2"
                              >
                                {row.attendance === 'present' ? 'Present' : 'Absent'}
                              </Badge>
                            )}
                          </>
                        )}
                      </td>
                      <td className="px-3 py-2 align-top">
                        {row.customerName}
                        {row.jobNumbers.length > 0 && (
                          <span className="block font-mono text-xs text-steel-400">
                            {row.jobNumbers.join(' ')}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right align-top tabular-nums">{hours(row.normalHours)}</td>
                      <td className="px-3 py-2 text-right align-top tabular-nums">{hours(row.overtimeHours)}</td>
                      <td className="px-3 py-2 text-right align-top tabular-nums">{hours(row.doubleHours)}</td>
                      <td className="px-3 py-2 text-right align-top tabular-nums">
                        {row.callouts === 0 ? '—' : row.callouts}
                      </td>
                      <td className="min-w-56 px-3 py-2 align-top">{commentCell(row)}</td>
                    </tr>
                  ))
                )}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-steel-300 font-semibold" data-testid="timesheet-totals">
                  <td className="px-5 py-2" colSpan={2}>
                    Total
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{hours(sheet.data.totals.normalHours)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{hours(sheet.data.totals.overtimeHours)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{hours(sheet.data.totals.doubleHours)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{sheet.data.totals.callouts || '—'}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
          <div className="border-t border-steel-100 px-5 py-3">
            <AddDayComment
              today={today}
              disabled={operation.running}
              onSave={(date, text) => void saveComment(date, text)}
            />
          </div>
        </Card>
      )}
    </>
  );
};

/** A comment for a day with no labour on it — a day off site, a training day. */
const AddDayComment = ({
  today,
  disabled,
  onSave,
}: {
  readonly today: string;
  readonly disabled: boolean;
  readonly onSave: (date: string, text: string) => void;
}) => {
  const [date, setDate] = useState(today);
  const [text, setText] = useState('');
  return (
    <div className="flex flex-wrap items-end gap-3">
      <TextField
        label="Comment on another day"
        type="date"
        value={date}
        max={today}
        onChange={(event) => setDate(event.target.value)}
        containerClassName="w-48"
      />
      <TextField
        label="Comment"
        value={text}
        maxLength={1000}
        onChange={(event) => setText(event.target.value)}
        containerClassName="min-w-64 flex-1"
      />
      <Button
        size="sm"
        variant="secondary"
        disabled={disabled || text.trim().length === 0 || date.length === 0}
        onClick={() => {
          onSave(date, text);
          setText('');
        }}
      >
        Add comment
      </Button>
    </div>
  );
};

export default TimesheetsPage;
