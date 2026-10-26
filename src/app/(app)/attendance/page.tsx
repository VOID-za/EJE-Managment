'use client';

import { useState } from 'react';
import { can, roleLabel, userFullName, type AttendanceStatus } from '@/domain';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  LoadingPanel,
  QueryFailure,
  TextField,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { DownloadFileButton } from '@/components/exports/DownloadFileButton';
import { attendance } from '@/api/endpoints';
import type { RegisterRow } from '@/application/attendance-operations';
import { useQuery } from '@/hooks/useQuery';
import { useOperation } from '@/hooks/useOperation';
import { useCurrentUser } from '@/providers/AppProvider';
import { businessToday } from '@/lib/business-time';
import { formatDateTime } from '@/lib/format';

/**
 * THE ATTENDANCE REGISTER. ATTEND-1. The office's screen.
 *
 * One day at a time: everybody on the system, Present or Absent, with a note
 * when one helps. Choosing again corrects the day — it never adds a second
 * record — and the trail keeps what it said before.
 *
 * PLANNED LEAVE IS SHOWN, NOT APPLIED. A person with leave booked for the day
 * carries a badge saying so, because that is what the office checks against;
 * the register still records what actually happened, and recording it does not
 * touch the leave. Job status plays no part.
 */
const AttendancePage = () => {
  const currentUser = useCurrentUser();
  const operation = useOperation();
  const [date, setDate] = useState(() => businessToday());
  const [notes, setNotes] = useState<Record<string, string>>({});
  const manages = can(currentUser.role, 'attendance.manage');

  const query = useQuery(`attendance:${date}`, () => attendance.register(date));

  if (!manages) {
    return (
      <EmptyState
        title="The attendance register is an office screen"
        description="The office records who was at work each day. Your own days are on your timesheet."
        icon={<Icon name="calendar" />}
      />
    );
  }

  const record = async (row: RegisterRow, status: AttendanceStatus): Promise<void> => {
    const note = notes[row.user.id] ?? row.record?.note ?? '';
    const ok = await operation.run(async () => {
      await attendance.record({ userId: row.user.id, date, status, note });
    });
    if (ok) query.refetch();
  };

  const data = query.data;
  const isFuture = data !== null && data !== undefined && date > data.today;

  return (
    <>
      <PageHeader
        title="Attendance"
        description="Who was at work, day by day. Kept apart from planned leave and from job status."
      />

      <Card className="mb-5">
        <div className="flex flex-wrap items-end gap-4">
          <TextField
            label="Day"
            type="date"
            value={date}
            max={data?.today}
            onChange={(event) => {
              if (event.target.value.length === 0) return;
              // A typed note belongs to the day it was typed on.
              setNotes({});
              setDate(event.target.value);
            }}
            containerClassName="w-48"
            data-testid="attendance-date"
          />
          {data !== null && data !== undefined && (
            <div className="flex flex-wrap gap-2 pb-2" data-testid="attendance-counts">
              <Badge tone="green">{data.present} present</Badge>
              <Badge tone="red">{data.absent} absent</Badge>
              <Badge tone="neutral">{data.unrecorded} not recorded</Badge>
            </div>
          )}
        </div>
        {isFuture && (
          <p role="alert" className="mt-3 text-sm font-medium text-signal-600">
            That day has not happened yet. Attendance is recorded on or after the day.
          </p>
        )}
        {operation.error !== null && (
          <p role="alert" className="mt-3 text-sm font-medium text-signal-600">
            {operation.error}
            {operation.violations.length > 0 && ` ${operation.violations.map((v) => v.message).join(' ')}`}
          </p>
        )}
      </Card>

      <AttendanceExport today={data?.today ?? date} />

      {query.error !== null ? (
        <QueryFailure code={query.errorCode} message={query.error} onRetry={query.refetch} />
      ) : query.loading || data === null || data === undefined ? (
        <LoadingPanel rows={6} label="Loading the register" />
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-steel-100" data-testid="attendance-register">
            {data.rows.map((row) => {
              const status = row.record?.status ?? null;
              return (
                <li
                  key={row.user.id}
                  className="flex flex-wrap items-center gap-3 px-5 py-3"
                  data-testid="attendance-row"
                  data-user={row.user.id}
                  data-status={status ?? 'unrecorded'}
                >
                  <div className="min-w-48 flex-1">
                    <p className="font-medium text-steel-900">{userFullName(row.user)}</p>
                    <p className="text-xs text-steel-500">
                      {row.user.jobTitle || roleLabel(row.user.role)}
                    </p>
                    {row.plannedLeave.length > 0 && (
                      <p className="mt-1 flex flex-wrap gap-1">
                        {row.plannedLeave.map((leave) => (
                          <Badge key={leave.type} tone="amber" size="sm">
                            Planned: {leave.label}
                          </Badge>
                        ))}
                      </p>
                    )}
                  </div>
                  <TextField
                    label="Note"
                    value={notes[row.user.id] ?? row.record?.note ?? ''}
                    onChange={(event) =>
                      setNotes((current) => ({ ...current, [row.user.id]: event.target.value }))
                    }
                    maxLength={500}
                    placeholder="Optional"
                    containerClassName="w-full sm:w-64"
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant={status === 'present' ? 'success' : 'secondary'}
                      disabled={operation.running || isFuture}
                      aria-pressed={status === 'present'}
                      onClick={() => void record(row, 'present')}
                    >
                      Present
                    </Button>
                    <Button
                      size="sm"
                      variant={status === 'absent' ? 'danger' : 'secondary'}
                      disabled={operation.running || isFuture}
                      aria-pressed={status === 'absent'}
                      onClick={() => void record(row, 'absent')}
                    >
                      Absent
                    </Button>
                  </div>
                  <p className="w-full text-xs text-steel-400 sm:w-auto">
                    {row.record === null
                      ? 'Not recorded'
                      : `Recorded by ${row.recordedByName ?? 'unknown'} · ${formatDateTime(row.record.recordedAt)}`}
                  </p>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </>
  );
};

/** The register for a range, as a spreadsheet. Recorded days only — nothing is assumed. */
const AttendanceExport = ({ today }: { readonly today: string }) => {
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  return (
    <Card className="mb-5">
      <div className="flex flex-wrap items-end gap-4">
        <TextField
          label="Export from"
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
        <DownloadFileButton
          href={attendance.exportUrl(from, to)}
          fallbackName={`attendance-${from}-${to}.csv`}
          label="Export CSV"
        />
      </div>
      <p className="mt-2 text-xs text-steel-500">
        One row per recorded day. A day nobody recorded is left out, not counted as absent.
      </p>
    </Card>
  );
};

export default AttendancePage;
