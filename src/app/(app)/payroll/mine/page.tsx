'use client';

import { PageHeader } from '@/components/layout/PageHeader';
import { MyMonthlyForms } from '@/components/payroll/MyMonthlyForms';

/** MY MONTHLY FORMS — everybody's own month and history (the tester, 30 October 2026). */
const MyMonthlyFormsPage = () => (
  <>
    <PageHeader
      title="My Monthly Forms"
      description="Your timesheet and attendance for the month: preview, print or download each as a one-page PDF, then submit both to the office together. Your earlier months are listed below."
    />
    <MyMonthlyForms />
  </>
);

export default MyMonthlyFormsPage;
