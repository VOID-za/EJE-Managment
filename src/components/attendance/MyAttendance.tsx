'use client';

import { useState } from 'react';
import { ABSENCE_REASON_LABELS, type AbsenceReason, type AttendanceStatus } from '@/domain';
import { Badge, Button, Card, LoadingPanel, QueryFailure, TextField } from '@/components/ui';
import { attendance } from '@/api/endpoints';
import { useQuery } from '@/hooks/useQuery';
import { useOperation } from '@/hooks/useOperation';
import { useCurrentUser } from '@/providers/AppProvider';
import { businessToday } from '@/lib/business-time';
import { formatDate } from '@/lib/format';
import { weekdayOf } from '@/lib/timesheet-dates';
import { AbsenceReasonPicker } from './AbsenceReasonPicker';

const daysBefore = (date: string, days: number): string => {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() - days);
  return at.toISOString().slice(0, 10);
};

/**
 * MY ATTENDANCE. ATTEND-2, the owner's instruction of 27 October 2026.
 *
 * Each technician marks themselves Present or Absent for each day — daily, or
 * catching up later (payday). Nothing is inferred from jobs, timesheets or
 * logins: a day nobody marked says NOT RECORDED. A day can be corrected; the
 * register keeps one record per person per day and the correction is on the
 * audit trail.
 */
export const MyAttendance = () => {
  const currentUser = useCurrentUser();
  const operation = useOperation();
  const today = businessToday();
  const [from, setFrom] = useState(() => daysBefore(today, 30));
  // The day whose absence reason is being chosen (ATT-01).
  const [choosing, setChoosing] = useState<string | null>(null);
  const query = useQuery(`attendance:mine:${currentUser.id}:${from}`, () => attendance.mine(from, today));

  const mark = async (
    date: string,
    status: AttendanceStatus,
    note: string,
    absenceReason: AbsenceReason | null = null,
  ): Promise<void> => {
    const ok = await operation.run(async () => {
      await attendance.record({ userId: currentUser.id, date, status, absenceReason, note });
    });
    if (ok) {
      setChoosing(null);
      query.refetch();
    }
  };

  return (
    <Card>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-steel-900">My attendance</p>
          <p className="text-xs text-steel-500">
            Mark yourself Present or Absent for each day. You can catch up on earlier days and correct a day; every
            change is recorded.
          </p>
        </div>
        <TextField
          label="Show from"
          type="date"
          value={from}
          max={today}
          onChange={(event) => event.target.value.length > 0 && setFrom(event.target.value)}
          containerClassName="w-44"
        />
      </div>
      {operation.error !== null && (
        <p role="alert" className="mt-2 text-sm font-medium text-signal-600">
          {operation.error}
        </p>
      )}
      {query.error !== null ? (
        <QueryFailure code={query.errorCode} message={query.error} onRetry={query.refetch} />
      ) : query.loading || query.data === null || query.data === undefined ? (
        <LoadingPanel rows={5} label="Loading your days" />
      ) : (
        <>
          <p className="mt-3 text-sm" data-testid="my-attendance-unrecorded">
            {query.data.unrecorded === 0
              ? 'Every day shown is recorded.'
              : `${query.data.unrecorded} ${query.data.unrecorded === 1 ? 'day is' : 'days are'} not recorded yet.`}
          </p>
          <ul className="mt-3 divide-y divide-steel-100" data-testid="my-attendance">
            {query.data.days.map((day) => (
              <li
                key={day.date}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
                data-testid="my-attendance-day"
                data-date={day.date}
                data-status={day.record?.status ?? 'unrecorded'}
              >
                <div className="flex items-center gap-2">
                  <span className="w-40 font-medium text-steel-900">
                    {weekdayOf(day.date)} {formatDate(day.date)}
                  </span>
                  {day.record === null ? (
                    <Badge tone="amber" size="sm">Not recorded</Badge>
                  ) : day.record.status === 'present' ? (
                    <Badge tone="green" size="sm">Present</Badge>
                  ) : (
                    <span data-testid="my-attendance-reason">
                      <Badge tone="red" size="sm">
                        Absent — {day.record.absenceReason === null ? 'reason not recorded' : ABSENCE_REASON_LABELS[day.record.absenceReason]}
                      </Badge>
                    </span>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant={day.record?.status === 'present' ? 'primary' : 'secondary'}
                    disabled={operation.running}
                    onClick={() => void mark(day.date, 'present', day.record?.note ?? '')}
                  >
                    Present
                  </Button>
                  <Button
                    size="sm"
                    variant={day.record?.status === 'absent' ? 'primary' : 'secondary'}
                    disabled={operation.running}
                    onClick={() => setChoosing(day.date)}
                    data-testid="my-attendance-absent"
                  >
                    Absent
                  </Button>
                </div>
                {choosing === day.date && (
                  <AbsenceReasonPicker
                    initial={day.record?.absenceReason ?? null}
                    busy={operation.running}
                    onConfirm={(reason) => void mark(day.date, 'absent', day.record?.note ?? '', reason)}
                    onCancel={() => setChoosing(null)}
                  />
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
};
