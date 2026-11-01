'use client';

import { useState } from 'react';
import { Card, TextField } from '@/components/ui';
import { MonthlyFormsCard } from '@/components/payroll/MonthlyFormsCard';
import { useCurrentUser } from '@/providers/AppProvider';
import { businessToday } from '@/lib/business-time';
import { isPayrollMonth, monthOfDate, previousMonth } from '@/lib/payroll-files';

/**
 * MY MONTHLY ATTENDANCE FORM, ON THE ATTENDANCE PAGE. PAY-01, PAY-02
 * (30 October 2026).
 *
 * Preview, Print, Download PDF, Export PDF, the month's status and Send to
 * office — through the SAME card, endpoints and rules as My Monthly Forms, so
 * the two pages can never disagree about a month.
 *
 * THE SIGNED-IN PERSON'S OWN MONTH ONLY, for every role (ATT-OWN-1, the tester,
 * 1 November 2026). The office's list of every user's month went with the Team
 * register; the office reads anybody's forms on EJE Monthly Forms.
 */
export const MonthlyAttendanceForms = () => {
  const user = useCurrentUser();
  const [month, setMonth] = useState(previousMonth(monthOfDate(businessToday())));
  const valid = isPayrollMonth(month);

  return (
    <section className="mb-5" data-testid="monthly-attendance-own">
      <Card className="mb-3">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-steel-900">My monthly attendance form</p>
            <p className="text-xs text-steel-500">
              Your attendance for the month as a one-page PDF: preview, print, download or export it, then send it to the office.
            </p>
          </div>
          <TextField
            label="Month"
            type="month"
            value={month}
            onChange={(event) => setMonth(event.target.value)}
            containerClassName="w-48"
            data-testid="monthly-attendance-month"
          />
        </div>
        {!valid && <p role="alert" className="mt-2 text-sm font-medium text-signal-600">Choose a month.</p>}
      </Card>
      {valid && <MonthlyFormsCard key={`${user.id}:${month}`} userId={user.id} month={month} focus="attendance" />}
    </section>
  );
};
