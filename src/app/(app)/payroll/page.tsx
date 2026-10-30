'use client';

import { useState } from 'react';
import { can } from '@/domain';
import { Card, TextField } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { MonthlyFormsCard } from '@/components/payroll/MonthlyFormsCard';
import { FinancePackagePanel } from '@/components/payroll/FinancePackagePanel';
import { MyMonthlyForms } from '@/components/payroll/MyMonthlyForms';
import { useCurrentUser } from '@/providers/AppProvider';
import { businessToday } from '@/lib/business-time';
import { isPayrollMonth, monthOfDate, previousMonth } from '@/lib/payroll-files';

/**
 * EJE MONTHLY FORMS. PAY-05 … PAY-08; renamed and widened by the tester on
 * 30 October 2026.
 *
 * The office (Master, Coordinator): EVERY user's month — Masters, Coordinators
 * and Technicians — who has submitted and who has not, any person's forms to
 * read and print, and the Finance package: the selected users' two PDFs each in
 * ONE email, with the duplicate, integrity, correction and audit rules it has
 * always had. Their OWN month is on My Monthly Forms.
 *
 * Anybody else who opens this address (an old link, a bookmark) gets their own
 * forms, as before — the server refuses them the office's month regardless.
 */
const PayrollPage = () => {
  const user = useCurrentUser();
  const office = can(user.role, 'payroll.finance');
  const [month, setMonth] = useState(previousMonth(monthOfDate(businessToday())));
  const [viewing, setViewing] = useState<string | null>(null);
  const valid = isPayrollMonth(month);

  if (!office) {
    return (
      <>
        <PageHeader
          title="My Monthly Forms"
          description="Your timesheet and attendance for the month: preview, print or download each as a one-page PDF, then submit both to the office together."
        />
        <MyMonthlyForms />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="EJE Monthly Forms"
        description="Every user’s monthly timesheet and attendance — who has submitted and who has not — and the month’s package for Finance: every selected user’s two PDFs in one email."
      />
      <Card className="mb-5">
        <TextField
          label="Month"
          type="month"
          value={month}
          onChange={(event) => {
            setMonth(event.target.value);
            setViewing(null);
          }}
          containerClassName="w-48"
          data-testid="payroll-month"
        />
        {!valid && <p role="alert" className="mt-2 text-sm font-medium text-signal-600">Choose a month.</p>}
      </Card>

      {valid && <FinancePackagePanel month={month} onOpenForms={(id) => setViewing(id)} />}
      {valid && viewing !== null && <MonthlyFormsCard key={`${viewing}:${month}`} userId={viewing} month={month} />}
    </>
  );
};

export default PayrollPage;
