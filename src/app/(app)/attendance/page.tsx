'use client';

import { PageHeader } from '@/components/layout/PageHeader';
import { MyAttendance } from '@/components/attendance/MyAttendance';
import { MonthlyAttendanceForms } from '@/components/attendance/MonthlyAttendanceForms';

/**
 * ATTENDANCE — EVERYBODY'S OWN. ATTEND-2, ATT-OWN-1 (the tester, 1 November 2026).
 *
 * One page, the same for every role: the person's own monthly attendance form
 * (Preview, Print, Download PDF, Export PDF, Send to office) and their own
 * days, which save themselves (ATT-AUTO-1).
 *
 * THE TEAM REGISTER IS GONE. The office's half of this page — every user's
 * day, recorded by a Master or a Coordinator, with its range export and every
 * user's monthly forms — was withdrawn: nobody records another person's
 * attendance (refused by the server too, `recordAttendance`). The office reads
 * everybody's attendance, and exports it, on EJE Monthly Forms.
 */
const AttendancePage = () => (
  <>
    <PageHeader
      title="Attendance"
      description="Mark yourself Present or Absent for each day. Each choice saves by itself. Nothing is filled in for you, and only you can record your days."
    />
    <MonthlyAttendanceForms />
    <MyAttendance />
  </>
);

export default AttendancePage;
