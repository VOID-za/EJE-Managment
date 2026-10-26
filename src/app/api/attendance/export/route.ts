import { z } from 'zod';
import { loadAttendanceExport, type AttendanceExportRow } from '@/application/attendance-operations';
import { describeExport, recordExport } from '@/application/export-audit';
import { csvFileName, toCsv, type CsvColumn } from '@/lib/csv';
import { downloadRoute, parseWith } from '@/server/api/handler';

/**
 * `GET /api/attendance/export?from=&to=` — the register as a CSV. ATTEND-1.
 * The office's (the operation refuses anybody else), and on the audit trail
 * like every other export (BD-18).
 */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Expected a date as YYYY-MM-DD');

const COLUMNS: readonly CsvColumn<AttendanceExportRow>[] = [
  { header: 'Date', value: (row) => row.date },
  { header: 'Person', value: (row) => row.person },
  { header: 'Role', value: (row) => row.role },
  { header: 'Attendance', value: (row) => (row.status === 'present' ? 'Present' : 'Absent') },
  { header: 'Note', value: (row) => row.note },
  { header: 'Recorded by', value: (row) => row.recordedBy },
  { header: 'Recorded at', value: (row) => row.recordedAt },
  { header: 'Planned leave', value: (row) => row.plannedLeave },
];

export const GET = downloadRoute('attendance.export', async (context) => {
  const { from, to } = parseWith(
    z.object({ from: day, to: day }).strict(),
    Object.fromEntries(context.request.nextUrl.searchParams),
  );
  const operation = { repos: context.repos, services: context.services, actor: context.actor.user };
  const rows = await loadAttendanceExport(operation, from, to);
  await recordExport(
    operation,
    describeExport({
      kind: 'attendance',
      actor: context.actor.user,
      filters: { from, to },
      rowCount: rows.length,
      columns: COLUMNS.map((column) => column.header),
      takenAt: context.services.clock.now(),
    }),
  );
  return {
    fileName: csvFileName(`eje-attendance-${from}-to`, to),
    contentType: 'text/csv; charset=utf-8',
    body: toCsv(COLUMNS, rows),
  };
});
