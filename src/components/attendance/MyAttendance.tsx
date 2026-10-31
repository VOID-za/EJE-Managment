'use client';

import { useState } from 'react';
import { ABSENCE_REASON_LABELS, type AttendanceRecord } from '@/domain';
import { Badge, Button, Card, LoadingPanel, QueryFailure, TextField } from '@/components/ui';
import { attendance } from '@/api/endpoints';
import { useQuery } from '@/hooks/useQuery';
import { useCurrentUser } from '@/providers/AppProvider';
import { businessToday } from '@/lib/business-time';
import { formatDate } from '@/lib/format';
import { isCalendarDay, weekdayOf } from '@/lib/timesheet-dates';
import { autosaveKey, type AttendanceAnswer } from '@/lib/attendance-autosave';
import { AbsenceReasonPicker } from './AbsenceReasonPicker';
import { AutosaveStatus } from './AutosaveStatus';
import { useAttendanceAutosave } from './useAttendanceAutosave';

const daysBefore = (date: string, days: number): string => {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() - days);
  return at.toISOString().slice(0, 10);
};

/**
 * Where the list starts: 30 days back — or the `from` in the address, which is
 * how My Monthly Forms' "Edit my attendance" opens exactly its month. Read
 * once, in the browser; the server renders the loading panel.
 */
const initialFrom = (today: string): string => {
  const fallback = daysBefore(today, 30);
  if (typeof window === 'undefined') return fallback;
  const asked = new URLSearchParams(window.location.search).get('from') ?? '';
  return isCalendarDay(asked) && asked <= today && asked >= daysBefore(today, 365) ? asked : fallback;
};

const answerOf = (record: AttendanceRecord | null): AttendanceAnswer => ({
  status: record?.status ?? null,
  absenceReason: record?.absenceReason ?? null,
  note: record?.note ?? '',
});

/**
 * MY ATTENDANCE. ATTEND-2, the owner's instruction of 27 October 2026.
 *
 * Each person marks themselves Present or Absent for each day — daily, or
 * catching up later (payday). Nothing is inferred from jobs, timesheets or
 * logins: a day nobody marked says NOT RECORDED. A day can be corrected; the
 * register keeps one record per person per day and the correction is on the
 * audit trail.
 *
 * IT SAVES ITSELF (ATT-AUTO-1, the tester, 31 October 2026). A tap is shown at
 * once, queued, and saved a moment later; the status line says when it is
 * saved, and a day not yet saved says so. Nothing is disabled while a save is
 * in flight — every tap is kept. See `AttendanceAutosaver`.
 */
export const MyAttendance = () => {
  const currentUser = useCurrentUser();
  const today = businessToday();
  const [from, setFrom] = useState(() => initialFrom(today));
  const query = useQuery(`attendance:mine:${currentUser.id}:${from}`, () => attendance.mine(from, today));
  const { saver, conflict, dismissConflict } = useAttendanceAutosave('mine');

  const shown = (date: string, record: AttendanceRecord | null) => {
    const pending = saver?.answerFor(currentUser.id, date) ?? null;
    return { answer: pending ?? answerOf(record), unsaved: pending?.unsaved === true, refused: pending?.refused };
  };
  const choose = (date: string, record: AttendanceRecord | null, answer: AttendanceAnswer) =>
    saver?.change(currentUser.id, date, answer, record?.recordedAt ?? null);

  const days = query.data?.days ?? [];
  const unrecorded = days.filter((day) => shown(day.date, day.record).answer.status === null).length;

  return (
    <Card>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-steel-900">My attendance</p>
          <p className="text-xs text-steel-500">
            Mark yourself Present or Absent for each day. Each choice saves by itself. You can catch up on earlier days
            and correct a day; every change is recorded.
          </p>
        </div>
        <TextField
          label="Show from"
          type="date"
          value={from}
          max={today}
          onChange={(event) => event.target.value.length > 0 && setFrom(event.target.value)}
          containerClassName="w-44"
          data-testid="my-attendance-from"
        />
      </div>
      <div className="mt-3">
        {saver !== null && (
          <AutosaveStatus state={saver.state()} onRetry={() => saver.retry()} conflict={conflict} onDismissConflict={dismissConflict} />
        )}
      </div>
      {query.error !== null ? (
        <QueryFailure code={query.errorCode} message={query.error} onRetry={query.refetch} />
      ) : query.loading || query.data === null || query.data === undefined ? (
        <LoadingPanel rows={5} label="Loading your days" />
      ) : (
        <>
          <p className="text-sm" data-testid="my-attendance-unrecorded">
            {unrecorded === 0
              ? 'Every day shown is recorded.'
              : `${unrecorded} ${unrecorded === 1 ? 'day is' : 'days are'} not recorded yet.`}
          </p>
          <ul className="mt-3 divide-y divide-steel-100" data-testid="my-attendance">
            {days.map((day) => {
              const { answer, unsaved, refused } = shown(day.date, day.record);
              const key = autosaveKey(currentUser.id, day.date);
              return (
                <li
                  key={day.date}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                  data-testid="my-attendance-day"
                  data-date={day.date}
                  data-status={answer.status ?? 'unrecorded'}
                  data-saved={unsaved ? 'no' : 'yes'}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="w-40 font-medium text-steel-900">
                      {weekdayOf(day.date)} {formatDate(day.date)}
                    </span>
                    {answer.status === null ? (
                      <Badge tone="amber" size="sm">Not recorded</Badge>
                    ) : answer.status === 'present' ? (
                      <Badge tone="green" size="sm">Present</Badge>
                    ) : (
                      <span data-testid="my-attendance-reason">
                        <Badge tone="red" size="sm">
                          Absent — {answer.absenceReason === null ? 'reason not recorded' : ABSENCE_REASON_LABELS[answer.absenceReason]}
                        </Badge>
                      </span>
                    )}
                    {unsaved && refused === undefined && (
                      <span className="text-xs text-steel-500" data-testid="my-attendance-unsaved">Not saved yet</span>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant={answer.status === 'present' ? 'primary' : 'secondary'}
                      aria-pressed={answer.status === 'present'}
                      onClick={() => choose(day.date, day.record, { status: 'present', absenceReason: null, note: answer.note })}
                      data-testid="my-attendance-present"
                    >
                      Present
                    </Button>
                    <Button
                      size="sm"
                      variant={answer.status === 'absent' ? 'primary' : 'secondary'}
                      aria-pressed={answer.status === 'absent'}
                      onClick={() =>
                        answer.status !== 'absent' &&
                        choose(day.date, day.record, { status: 'absent', absenceReason: day.record?.status === 'absent' ? day.record.absenceReason : null, note: answer.note })
                      }
                      data-testid="my-attendance-absent"
                    >
                      Absent
                    </Button>
                  </div>
                  {answer.status === 'absent' && (
                    <AbsenceReasonPicker
                      value={answer.absenceReason}
                      onChoose={(reason) => choose(day.date, day.record, { status: 'absent', absenceReason: reason, note: answer.note })}
                      onCancel={() => saver?.discard(key)}
                    />
                  )}
                  {refused !== undefined && (
                    <p role="alert" className="flex w-full flex-wrap items-center gap-2 text-sm text-signal-600" data-testid="my-attendance-refused">
                      Not saved: {refused}
                      <Button size="sm" variant="ghost" onClick={() => saver?.discard(key)}>
                        Undo my change
                      </Button>
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Card>
  );
};
