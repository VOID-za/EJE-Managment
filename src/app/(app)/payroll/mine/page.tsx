'use client';

import { PageHeader } from '@/components/layout/PageHeader';
import { MyMonthlyForms } from '@/components/payroll/MyMonthlyForms';

/** MY MONTHLY FORMS — everybody's own month and history (the tester, 30 October 2026). */
const MyMonthlyFormsPage = () => (
  <>
    <PageHeader
      title="My Monthly Forms"
      description="Your completed timesheet and attendance wait here, locked: preview, print, download or save each PDF, then submit both to the office together. Everything you submitted is in the history below."
    />
    <MyMonthlyForms />
  </>
);

export default MyMonthlyFormsPage;
