'use client';

import { useState } from 'react';
import { can, userFullName } from '@/domain';
import { Card, SelectField, TextField } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { MonthlyFormsCard } from '@/components/payroll/MonthlyFormsCard';
import { FinancePackagePanel } from '@/components/payroll/FinancePackagePanel';
import { timesheets } from '@/api/endpoints';
import { useQuery } from '@/hooks/useQuery';
import { useCurrentUser } from '@/providers/AppProvider';
import { businessToday } from '@/lib/business-time';
import { isPayrollMonth, monthOfDate, previousMonth } from '@/lib/payroll-files';

/**
 * MONTHLY FORMS. PAY-01 … PAY-08 (29 October 2026).
 *
 * A technician: their month's timesheet and attendance — Preview, Print,
 * Download/Export PDF (one page each, named "JC TIMESHEET OCT.pdf" and "JC
 * ATTEN OCTOBER.pdf") — and Submit, the two together, once.
 *
 * The office: every technician's status for the month and the Finance package
 * — selected technicians' forms in ONE email — and any technician's forms to
 * read and print. The month opens on last month (payroll is done after the
 * month ends) and resets on every visit.
 */
const PayrollPage = () => {
  const user = useCurrentUser();
  const office = can(user.role, 'payroll.finance');
  const [month, setMonth] = useState(previousMonth(monthOfDate(businessToday())));
  const [viewing, setViewing] = useState<string | null>(null);
  const people = useQuery(`payroll:people:${user.id}`, () => timesheets.people());
  const valid = isPayrollMonth(month);
  const formsFor = office ? viewing : user.id;

  return (
    <>
      <PageHeader
        title="Monthly forms"
        description={
          office
            ? 'Each technician’s monthly timesheet and attendance, and the month’s payroll package for Finance — every selected technician’s two PDFs in one email.'
            : 'Your timesheet and attendance for the month: preview, print or download each as a one-page PDF, then submit both to the office together.'
        }
      />
      <Card className="mb-5">
        <div className="flex flex-wrap items-end gap-4">
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
          {office && (people.data ?? []).length > 0 && (
            <SelectField
              label="Technician’s forms"
              value={viewing ?? ''}
              onChange={(event) => setViewing(event.target.value === '' ? null : event.target.value)}
              options={[{ value: '', label: 'Choose a technician…' }, ...(people.data ?? []).map((person) => ({ value: person.id, label: userFullName(person) }))]}
              containerClassName="w-64"
              data-testid="payroll-technician"
            />
          )}
        </div>
        {!valid && <p role="alert" className="mt-2 text-sm font-medium text-signal-600">Choose a month.</p>}
      </Card>

      {valid && office && <FinancePackagePanel month={month} onOpenForms={(id) => setViewing(id)} />}
      {valid && formsFor !== null && <MonthlyFormsCard key={`${formsFor}:${month}`} userId={formsFor} month={month} />}
    </>
  );
};

export default PayrollPage;
