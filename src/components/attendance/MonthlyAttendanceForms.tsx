'use client';

import { useState } from 'react';
import Link from 'next/link';
import { can } from '@/domain';
import { Badge, Button, Card, LoadingPanel, QueryFailure, TextField } from '@/components/ui';
import { MonthlyFormsCard } from '@/components/payroll/MonthlyFormsCard';
import { PAYROLL_STATUS } from '@/components/payroll/FinancePackagePanel';
import { payroll } from '@/api/endpoints';
import { useQuery } from '@/hooks/useQuery';
import { useCurrentUser } from '@/providers/AppProvider';
import { businessToday } from '@/lib/business-time';
import { isPayrollMonth, monthOfDate, previousMonth } from '@/lib/payroll-files';

/**
 * THE MONTHLY ATTENDANCE FORM, ON THE ATTENDANCE PAGE. PAY-01, PAY-02
 * (30 October 2026).
 *
 * The owner found the Attendance page without the controls the Time Sheet has:
 * they were built on Monthly forms only. This puts them where people look —
 * Preview, Print, Download PDF, Export PDF, the month's status and Send to
 * office — through the SAME card, endpoints and rules as Monthly forms, so the
 * two pages can never disagree about a month.
 *
 * A technician sees their own month. The office (Master, Coordinator) sees
 * every technician's status for the month and opens any one of them to read,
 * print or export; a day is corrected in the register above, and the form then
 * says it was corrected by the office after submission. The office does not
 * send a technician's month for them — the server refuses that too.
 */
export const MonthlyAttendanceForms = ({ scope }: { readonly scope?: 'own' | 'office' } = {}) => {
  const user = useCurrentUser();
  /*
   * 'own' is the person's own month — every role's, at the top of the page
   * (the tester, 30 October 2026: the office's Attendance page has the
   * technician's layout). 'office' is every user's month, for the office.
   */
  const office = (scope ?? (can(user.role, 'payroll.finance') ? 'office' : 'own')) === 'office' && can(user.role, 'payroll.finance');
  const [month, setMonth] = useState(previousMonth(monthOfDate(businessToday())));
  const [viewing, setViewing] = useState<string | null>(null);
  const valid = isPayrollMonth(month);
  const formsFor = office ? viewing : user.id;

  return (
    <section className="mb-5" data-testid={office ? 'monthly-attendance-section' : 'monthly-attendance-own'}>
      <Card className="mb-3">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-steel-900">{office ? 'Everybody’s monthly attendance' : 'My monthly attendance form'}</p>
            <p className="text-xs text-steel-500">
              {office
                ? 'Each user’s attendance for the month as its one-page PDF, and whether it was sent to the office.'
                : 'Your attendance for the month as a one-page PDF: preview, print, download or export it, then send it to the office.'}
            </p>
          </div>
          <TextField
            label="Month"
            type="month"
            value={month}
            onChange={(event) => {
              setMonth(event.target.value);
              setViewing(null);
            }}
            containerClassName="w-48"
            data-testid="monthly-attendance-month"
          />
        </div>
        {!valid && <p role="alert" className="mt-2 text-sm font-medium text-signal-600">Choose a month.</p>}
        {valid && office && <OfficeMonthStatus month={month} viewing={viewing} onOpen={setViewing} />}
      </Card>
      {valid && formsFor !== null && (
        <MonthlyFormsCard key={`${formsFor}:${month}`} userId={formsFor} month={month} focus="attendance" />
      )}
    </section>
  );
};

/** Every technician's month at a glance, and the way into their form. */
const OfficeMonthStatus = ({
  month,
  viewing,
  onOpen,
}: {
  readonly month: string;
  readonly viewing: string | null;
  readonly onOpen: (userId: string) => void;
}) => {
  const view = useQuery(`payroll:month:${month}`, () => payroll.month(month));
  if (view.error !== null) return <QueryFailure code={view.errorCode} message={view.error} onRetry={view.refetch} />;
  if (view.loading || view.data === null || view.data === undefined) return <LoadingPanel rows={3} label="Loading the month" />;
  const rows = view.data.rows;
  return (
    <div className="mt-3">
      {rows.length === 0 ? (
        <p className="text-sm text-steel-500">No technicians for this month.</p>
      ) : (
        <ul className="divide-y divide-steel-100" data-testid="monthly-attendance-status">
          {rows.map((row) => (
            <li
              key={row.technician.id}
              className="flex flex-wrap items-center gap-3 py-2"
              data-testid="monthly-attendance-row"
              data-user={row.technician.id}
              data-status={row.status}
            >
              <span className="min-w-40 flex-1 font-medium text-steel-900">{row.technician.name}</span>
              <Badge tone={PAYROLL_STATUS[row.status].tone} size="sm">{PAYROLL_STATUS[row.status].label}</Badge>
              <span className="text-xs text-steel-500">
                {row.fileNames.attendance}
                {row.attendanceChangedAfterSubmission > 0 ? ` · corrected by the office after submission (${row.attendanceChangedAfterSubmission})` : ''}
                {row.submittedAt === null && row.unrecordedWeekdays > 0 ? ` · ${row.unrecordedWeekdays} weekday${row.unrecordedWeekdays === 1 ? '' : 's'} not recorded` : ''}
              </span>
              <Button
                size="sm"
                variant={viewing === row.technician.id ? 'primary' : 'secondary'}
                onClick={() => onOpen(row.technician.id)}
                data-testid="monthly-attendance-open"
              >
                Open form
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-steel-500">
        The month&apos;s package for Finance — every selected technician&apos;s timesheet and attendance in one email —
        is prepared on <Link href="/payroll" className="font-medium text-eje-700 underline">Monthly forms</Link>.
      </p>
    </div>
  );
};
