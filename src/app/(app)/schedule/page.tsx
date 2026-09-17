import { redirect } from 'next/navigation';

/**
 * The Schedule screen has been superseded by the Calendar, which shows the same
 * work alongside technician availability and supports day, week, month and year
 * views. Kept as a redirect so any saved link still lands somewhere sensible.
 */
const SchedulePage = () => {
  redirect('/calendar');
};

export default SchedulePage;
