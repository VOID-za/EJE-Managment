'use client';

import { useState } from 'react';
import { ABSENCE_REASON_LABELS, can, roleLabel, userFullName, type AbsenceReason, type AttendanceStatus } from '@/domain';
import {
  Badge,
  Button,
  Card,
  LoadingPanel,
  QueryFailure,
  TextField,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { MyAttendance } from '@/components/attendance/MyAttendance';
import { AbsenceReasonPicker } from '@/components/attendance/AbsenceReasonPicker';
import { MonthlyAttendanceForms } from '@/components/attendance/MonthlyAttendanceForms';
import { AutosaveStatus } from '@/components/attendance/AutosaveStatus';
import { useAttendanceAutosave } from '@/components/attendance/useAttendanceAutosave';
import { DownloadFileButton } from '@/components/exports/DownloadFileButton';
import { attendance } from '@/api/endpoints';
import type { RegisterRow } from '@/application/attendance-operations';
import { useQuery } from '@/hooks/useQuery';
import { useCurrentUser } from '@/providers/AppProvider';
import { businessToday } from '@/lib/business-time';
import { formatDateTime } from '@/lib/format';
import { autosaveKey, type AttendanceAnswer } from '@/lib/attendance-autosave';

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
 *
 * THE MONTHLY FORM IS HERE TOO (30 October 2026): Preview, Print, Download PDF,
 * Export PDF and Send to office for the month — see `MonthlyAttendanceForms`.
 *
 * THE REGISTER SAVES ITSELF (ATT-AUTO-1, the tester, 31 October 2026), like My
 * attendance: Present, Absent with its reason, and the note — typed and left,
 * it is saved after a pause, where it used to be lost unless a status button
 * was pressed after it. The status line says what is saved.
 */
const AttendancePage = () => {
  const currentUser = useCurrentUser();
  // ATTEND-2: a technician marks their own days; the register below is the office's.
  if (!can(currentUser.role, 'attendance.manage')) {
    return (
      <>
        <PageHeader
          title="Attendance"
          description="Mark yourself Present or Absent for each day. Each choice saves by itself. Nothing is filled in for you."
        />
        <MonthlyAttendanceForms scope="own" />
        <MyAttendance />
      </>
    );
  }
  return <OfficeAttendance />;
};

const OfficeAttendance = () => {
  const [date, setDate] = useState(() => businessToday());
  const query = useQuery(`attendance:${date}`, () => attendance.register(date));
  const { saver, conflict, dismissConflict } = useAttendanceAutosave('register');

  /** What a row shows: a change not yet saved, else the record. */
  const shown = (row: RegisterRow): AttendanceAnswer & { readonly unsaved: boolean; readonly refused?: string } => {
    const pending = saver?.answerFor(row.user.id, date) ?? null;
    if (pending !== null) return pending;
    return { status: row.record?.status ?? null, absenceReason: row.record?.absenceReason ?? null, note: row.record?.note ?? '', unsaved: false };
  };

  const data = query.data;
  const isFuture = data !== null && data !== undefined && date > data.today;

  return (
    <>
      <PageHeader
        title="Attendance"
        description="Your own days and monthly form first — the same as every technician's — then the team register. Every choice saves by itself."
      />

      {/* The technician's layout, for the office's OWN attendance (the tester, 30 October 2026). */}
      <MonthlyAttendanceForms scope="own" />
      <div className="mb-8">
        <MyAttendance />
      </div>

      <h2 className="mb-1 text-lg font-semibold text-steel-900" data-testid="team-register-heading">Team register</h2>
      <p className="mb-4 text-sm text-steel-500">Who was at work, day by day. Kept apart from planned leave and from job status.</p>

      <Card className="mb-5">
        <div className="flex flex-wrap items-end gap-4">
          <TextField
            label="Day"
            type="date"
            value={date}
            max={data?.today}
            onChange={(event) => {
              if (event.target.value.length === 0) return;
              // A note being typed is already queued against the day it was typed on: send it now.
              saver?.flushNow();
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
      </Card>

      {saver !== null && (
        <AutosaveStatus state={saver.state()} onRetry={() => saver.retry()} conflict={conflict} onDismissConflict={dismissConflict} />
      )}

      <AttendanceExport today={data?.today ?? date} />

      <MonthlyAttendanceForms scope="office" />

      {query.error !== null ? (
        <QueryFailure code={query.errorCode} message={query.error} onRetry={query.refetch} />
      ) : query.loading || data === null || data === undefined ? (
        <LoadingPanel rows={6} label="Loading the register" />
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-steel-100" data-testid="attendance-register">
            {data.rows.map((row) => {
              const answer = shown(row);
              const status = answer.status;
              const key = autosaveKey(row.user.id, date);
              const choose = (
                next: { readonly status: AttendanceStatus | null; readonly absenceReason: AbsenceReason | null; readonly note: string },
                kind: 'choice' | 'note' = 'choice',
              ) => saver?.change(row.user.id, date, next, row.record?.recordedAt ?? null, kind);
              return (
                <li
                  key={row.user.id}
                  className="flex flex-wrap items-center gap-3 px-5 py-3"
                  data-testid="attendance-row"
                  data-user={row.user.id}
                  data-status={status ?? 'unrecorded'}
                  data-saved={answer.unsaved ? 'no' : 'yes'}
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
                    value={answer.note}
                    disabled={isFuture}
                    onChange={(event) => choose({ status, absenceReason: answer.absenceReason, note: event.target.value }, 'note')}
                    maxLength={500}
                    placeholder="Optional"
                    hint={status === null && answer.note.length > 0 ? 'Saved once Present or Absent is chosen.' : undefined}
                    containerClassName="w-full sm:w-64"
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant={status === 'present' ? 'success' : 'secondary'}
                      disabled={isFuture}
                      aria-pressed={status === 'present'}
                      onClick={() => choose({ status: 'present', absenceReason: null, note: answer.note })}
                    >
                      Present
                    </Button>
                    <Button
                      size="sm"
                      variant={status === 'absent' ? 'danger' : 'secondary'}
                      disabled={isFuture}
                      aria-pressed={status === 'absent'}
                      onClick={() =>
                        status !== 'absent' &&
                        choose({ status: 'absent', absenceReason: row.record?.status === 'absent' ? row.record.absenceReason : null, note: answer.note })
                      }
                    >
                      Absent
                    </Button>
                  </div>
                  {status === 'absent' && answer.absenceReason !== null && (
                    <Badge tone="red" size="sm">
                      {ABSENCE_REASON_LABELS[answer.absenceReason]}
                    </Badge>
                  )}
                  {status === 'absent' && (
                    <AbsenceReasonPicker
                      value={answer.absenceReason}
                      onChoose={(reason) => choose({ status: 'absent', absenceReason: reason, note: answer.note })}
                      onCancel={() => saver?.discard(key)}
                    />
                  )}
                  {answer.refused !== undefined && (
                    <p role="alert" className="flex w-full flex-wrap items-center gap-2 text-sm text-signal-600">
                      Not saved: {answer.refused}
                      <Button size="sm" variant="ghost" onClick={() => saver?.discard(key)}>
                        Undo my change
                      </Button>
                    </p>
                  )}
                  <p className="w-full text-xs text-steel-400 sm:w-auto">
                    {answer.unsaved && answer.refused === undefined
                      ? 'Not saved yet'
                      : row.record === null
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
