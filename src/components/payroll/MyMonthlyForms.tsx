'use client';

import { useState } from 'react';
import { Badge, Button, Card, LoadingPanel, QueryFailure, TextField } from '@/components/ui';
import { MonthlyFormsCard } from '@/components/payroll/MonthlyFormsCard';
import { payroll } from '@/api/endpoints';
import { useQuery } from '@/hooks/useQuery';
import { useCurrentUser } from '@/providers/AppProvider';
import { businessToday } from '@/lib/business-time';
import { formatDateTime } from '@/lib/format';
import { isPayrollMonth, monthOfDate, previousMonth } from '@/lib/payroll-files';

/**
 * MY MONTHLY FORMS. Everybody's own month — Technician, Coordinator and Master
 * alike (the tester, 30 October 2026).
 *
 * The month's timesheet and attendance with Preview, Print, Download PDF and
 * Export PDF, and Submit, the two together, once — the same card, endpoints
 * and rules a technician has always had. Below it, the HISTORY: every month
 * this person submitted, newest first, and opening one shows it as it was
 * submitted. The month opens on last month (payroll is done after it ends).
 */
export const MyMonthlyForms = () => {
  const user = useCurrentUser();
  const [month, setMonth] = useState(previousMonth(monthOfDate(businessToday())));
  const history = useQuery(`payroll:history:${user.id}`, () => payroll.history(user.id));
  const valid = isPayrollMonth(month);

  return (
    <div data-testid="my-monthly-forms">
      <Card className="mb-5">
        <TextField
          label="Month"
          type="month"
          value={month}
          onChange={(event) => setMonth(event.target.value)}
          containerClassName="w-48"
          data-testid="my-monthly-month"
        />
        {!valid && <p role="alert" className="mt-2 text-sm font-medium text-signal-600">Choose a month.</p>}
      </Card>

      {valid && <MonthlyFormsCard key={`${user.id}:${month}`} userId={user.id} month={month} onSubmitted={history.refetch} />}

      <Card className="mb-5" data-testid="my-monthly-history">
        <p className="text-sm font-semibold text-steel-900">History</p>
        <p className="text-xs text-steel-500">Every month you submitted to the office, newest first.</p>
        {history.error !== null ? (
          <QueryFailure code={history.errorCode} message={history.error} onRetry={history.refetch} />
        ) : history.loading || history.data === null || history.data === undefined ? (
          <LoadingPanel rows={2} label="Loading your history" />
        ) : history.data.length === 0 ? (
          <p className="mt-3 text-sm text-steel-500" data-testid="my-monthly-history-empty">Nothing submitted yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-steel-100">
            {history.data.map((entry) => (
              <li key={entry.month} className="flex flex-wrap items-center gap-3 py-2" data-testid="my-monthly-history-row" data-month={entry.month}>
                <span className="min-w-36 font-medium text-steel-900">{entry.monthLabel}</span>
                <Badge tone="green" size="sm">
                  Submitted {formatDateTime(entry.submittedAt)}
                </Badge>
                <span className="text-xs text-steel-500">
                  {entry.fileNames.timesheet} · {entry.fileNames.attendance}
                </span>
                <Button size="sm" variant={entry.month === month ? 'primary' : 'secondary'} onClick={() => setMonth(entry.month)}>
                  Open
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
};
