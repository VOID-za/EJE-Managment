'use client';

import { can, completesTimesheet } from '@/domain';
import { Badge, Card } from '@/components/ui';
import { TimesheetSubmissions } from '@/components/timesheets/TimesheetSubmissions';
import { reads, timesheets } from '@/api/endpoints';
import { useQuery } from '@/hooks/useQuery';
import { useCurrentUser } from '@/providers/AppProvider';

/**
 * SUBMITTED TIMESHEETS, ON MY MONTHLY FORMS (the owner, 6 November 2026).
 *
 * The working pages (Timesheets, Attendance) hold only what is being filled in;
 * everything submitted is here, where it was submitted:
 *  - YOURS — each timesheet you submitted, opened exactly as submitted (the
 *    original snapshot, and the corrected version in force when there is one),
 *    its PDF, and Corrections: ask for one with a reason (TS-16);
 *  - EVERY TECHNICIAN'S — for the office (`timesheets.viewAll`): the same, with
 *    the technician named, Export CSV, and the corrections to accept or reject.
 *
 * The server decides what each person may read and do on every one of these
 * (another technician's is refused; only the office exports or decides).
 */
export const SubmittedTimesheets = () => {
  const user = useCurrentUser();
  const keeps = completesTimesheet(user.role);
  const office = can(user.role, 'timesheets.viewAll');
  const mine = useQuery(`timesheets:working:${keeps ? user.id : 'none'}`, () => (keeps ? timesheets.working(user.id) : Promise.resolve(null)));
  const everybody = useQuery(`timesheets:submissions:all:${office ? 'yes' : 'no'}`, () => (office ? timesheets.submissions() : Promise.resolve(null)));
  const customers = useQuery(`timesheets:customers:${keeps || office ? 'yes' : 'no'}`, () => (keeps || office ? reads.customers() : Promise.resolve([])));

  return (
    <>
      {keeps && (
        <Card className="mb-5" data-testid="my-submitted-timesheets">
          <h2 className="text-sm font-semibold text-steel-900">Your submitted timesheets</h2>
          <p className="mb-2 text-xs text-steel-500">Each opens exactly as you submitted it. To change one, open Corrections and ask the office, with your reason.</p>
          <TimesheetSubmissions
            user={user}
            submissions={mine.data?.submissions ?? null}
            loading={mine.loading}
            error={mine.error}
            errorCode={mine.errorCode}
            onRetry={mine.refetch}
            showTechnician={false}
            customers={customers.data ?? []}
            onChanged={mine.refetch}
          />
        </Card>
      )}
      {office && (
        <Card className="mb-5" data-testid="timesheet-office">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-steel-900">Submitted timesheets — every technician</h2>
            <Badge tone="outline" size="sm">Office</Badge>
          </div>
          <p className="mb-3 text-xs text-steel-500">Each technician submits their own, with their attendance, here on My Monthly Forms. Open one to read it exactly as submitted, download its PDF or export its lines; decide the corrections asked for.</p>
          <TimesheetSubmissions
            user={user}
            submissions={everybody.data ?? null}
            loading={everybody.loading}
            error={everybody.error}
            errorCode={everybody.errorCode}
            onRetry={everybody.refetch}
            showTechnician
            customers={customers.data ?? []}
            onChanged={() => everybody.refetch()}
          />
        </Card>
      )}
    </>
  );
};
