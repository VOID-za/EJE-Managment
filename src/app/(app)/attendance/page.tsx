'use client';

import { useState } from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button, Card, Icon } from '@/components/ui';
import { DocumentPreviewDialog } from '@/components/documents/DocumentPreviewDialog';
import {
  AttendanceRangeFields,
  MyAttendance,
  useAttendanceRange,
} from '@/components/attendance/MyAttendance';
import { attendance } from '@/api/endpoints';
import { formatPeriod } from '@/lib/timesheet-dates';

/**
 * ATTENDANCE — EVERYBODY'S OWN. ATTEND-2, ATT-OWN-1 (the tester, 1 November 2026).
 *
 * FORMS-PAGES-1 (2 November 2026): the same first two blocks as the Timesheets
 * page — the From and To top-right, then the period with Preview and Print —
 * and then the person's own days, which save themselves (ATT-AUTO-1). Nothing
 * about a timesheet is on this page, and there is no Month selector, Download
 * or Submit: the monthly forms are downloaded and submitted on Monthly Forms.
 * Nothing here waits for the month to end.
 */
const AttendancePage = () => {
  const { range, usable, choose, today } = useAttendanceRange();
  const [previewing, setPreviewing] = useState<'preview' | 'print' | null>(null);
  const label = formatPeriod(range.from, range.to);

  return (
    <>
      <PageHeader
        title="Attendance"
        description="Mark yourself Present or Absent for each day. Each choice saves by itself. Nothing is filled in for you, and only you can record your days."
      />
      {/* The first block: the period's From and To, top-right — where the Month selector was. */}
      <Card className="mb-5" data-testid="attendance-filters">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-steel-900">Period</p>
            <p className="text-xs text-steel-500">Choose the days to show, at most 92. Your monthly form is submitted on Monthly Forms.</p>
          </div>
          <AttendanceRangeFields range={range} today={today} onChange={choose} />
        </div>
      </Card>
      <DocumentPreviewDialog
        open={previewing !== null}
        autoPrint={previewing === 'print'}
        allowDownload={false}
        title={`Attendance — ${label}`}
        description="Preview only. Nothing is saved or sent by looking at it; submit on Monthly Forms."
        loadPdf={() => attendance.periodPdf(range.from, range.to)}
        onClose={() => setPreviewing(null)}
      />
      {usable && (
        <Card className="mb-5" data-testid="attendance-period">
          <p className="text-sm font-semibold text-steel-900" data-testid="attendance-period-label">
            Attendance period: {label}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="secondary"
              leadingIcon={<Icon name="document" className="size-4" />}
              onClick={() => setPreviewing('preview')}
              data-testid="attendance-preview"
            >
              Preview
            </Button>
            <Button
              variant="secondary"
              leadingIcon={<Icon name="document" className="size-4" />}
              onClick={() => setPreviewing('print')}
              data-testid="attendance-print"
            >
              Print
            </Button>
          </div>
        </Card>
      )}
      <MyAttendance range={range} usable={usable} />
    </>
  );
};

export default AttendancePage;
