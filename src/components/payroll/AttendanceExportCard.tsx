'use client';

import { useState } from 'react';
import { Card, TextField } from '@/components/ui';
import { DownloadFileButton } from '@/components/exports/DownloadFileButton';
import { attendance } from '@/api/endpoints';
import { businessToday } from '@/lib/business-time';

/**
 * EVERYBODY'S ATTENDANCE FOR A RANGE, AS A SPREADSHEET. ATTEND-1, reporting.
 *
 * The office's (the server refuses anybody else). It lived beside the Team
 * register on the Attendance page; when the register was withdrawn (ATT-OWN-1,
 * 1 November 2026) the report moved here, where the office reads everybody's
 * attendance. Recorded days only — nothing is assumed.
 */
export const AttendanceExportCard = () => {
  const today = businessToday();
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  return (
    <Card className="mb-5" data-testid="attendance-export">
      <p className="text-sm font-semibold text-steel-900">Everybody’s attendance as a spreadsheet</p>
      <div className="mt-2 flex flex-wrap items-end gap-4">
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
        <DownloadFileButton href={attendance.exportUrl(from, to)} fallbackName={`attendance-${from}-${to}.csv`} label="Export CSV" />
      </div>
      <p className="mt-2 text-xs text-steel-500">
        One row per recorded day. A day nobody recorded is left out, not counted as absent. Reading only — each person records their own days.
      </p>
    </Card>
  );
};
