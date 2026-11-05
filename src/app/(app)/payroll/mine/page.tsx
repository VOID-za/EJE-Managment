'use client';

import { PageHeader } from '@/components/layout/PageHeader';
import { MyMonthlyForms } from '@/components/payroll/MyMonthlyForms';

/** MY MONTHLY FORMS — everybody's own month and history (the tester, 30 October 2026). */
const MyMonthlyFormsPage = () => (
  <>
    <PageHeader
      title="My Monthly Forms"
      description="Your timesheet and attendance for your pay period: preview, print, download, save or rename each PDF, then submit both to the office together. Everything you submitted is listed below."
    />
    <MyMonthlyForms />
  </>
);

export default MyMonthlyFormsPage;
