import type { Capability, UserRole } from '@/domain';

export interface NavigationItem {
  readonly href: string;
  readonly label: string;
  readonly icon: string;
  readonly capability?: Capability;
  /**
   * Only these roles, where a capability cannot say it. The tester's changes of
   * 30 October 2026: the Coordinator does not complete timesheets, yet still
   * holds the capabilities the Timesheets page reads with (the correction
   * review stays reachable from its notifications). The SERVER still decides
   * what each role may do; this only decides what the sidebar offers.
   */
  readonly roles?: readonly UserRole[];
  /** Marks a section heading in the sidebar. */
  readonly group: 'work' | 'records' | 'system';
}

/**
 * Navigation is data, not markup, so a role sees exactly the sections its
 * capabilities allow and nothing has to be conditionally hidden in the JSX.
 *
 * Machines deliberately have no top-level item. They belong to a site, which
 * belongs to a customer, and the hierarchy EJE actually works in is
 * customer -> site -> machine -> job history. The machine screens still exist
 * and global search still finds a machine directly by serial number.
 */
export const NAVIGATION: readonly NavigationItem[] = [
  { href: '/dashboard', label: 'Overview', icon: 'dashboard', group: 'work' },
  { href: '/jobs', label: 'Jobs', icon: 'jobs', group: 'work' },
  /**
   * Scheduled work and availability. EVERY ROLE. MASTER SCOPE §3.3, §16.
   *
   * The capability is the one the READ enforces (`calendarView`), for the same
   * reason Activity's is: offering a technician a screen that then refuses them
   * is how "Something went wrong" ends up on a sidebar item they were invited
   * to click. The two are deliberately the same capability — which is why this
   * said `availability.manage` and hid the calendar from the field. Both moved
   * together to `calendar.view`.
   */
  {
    href: '/calendar',
    label: 'Calendar',
    icon: 'calendar',
    capability: 'calendar.view',
    group: 'work',
  },
  /*
   * STANDBY-2 (2 November 2026): EVERY ROLE. The capability is the one the
   * read enforces (`standby.view`); the office additionally manages the year
   * and decides swaps on the same page (`standby.manage`, checked by the server).
   */
  { href: '/standby', label: 'Standby Calendar', icon: 'calendar', capability: 'standby.view', group: 'work' },
  /*
   * CLOSED JOBS IS NO LONGER A SIDEBAR ITEM (the tester, 30 October 2026, for
   * the Master and the Coordinator). The archive is unchanged and is reached
   * from the Jobs page, whose "Closed Jobs" filter opens it.
   */
  /**
   * Work a tablet could not get onto a job. THE OFFICE. BD-15.
   *
   * In *Work* rather than *System* because that is what it is: hours a
   * technician worked that are not on a job yet, waiting for somebody to
   * decide. It is not an administrative setting and it is not a log.
   *
   * The capability is the one the READ enforces (`captures.resolveReferral`),
   * for the same reason Activity's and the Calendar's are: offering a
   * technician a screen that then refuses them is how "Something went wrong"
   * ends up on a sidebar item they were invited to click.
   */
  /*
   * FIELD-CAP-1 (27 October 2026): everybody's — the office sees the queue, a
   * technician their own referred captures and what became of them.
   */
  { href: '/captures', label: 'Field Captures', icon: 'clock', group: 'work' },
  /*
   * ATTEND-2, ATT-OWN-1 (1 November 2026): everybody records their own
   * attendance and nobody else's, so the item is everybody's and the page is
   * the same for every role. The office reads everybody's on EJE Monthly Forms.
   */
  { href: '/attendance', label: 'Attendance', icon: 'user', group: 'work' },
  // TS-ROLE-1: a Coordinator keeps no timesheet (the tester, 30 October and 1 November 2026); the server refuses it too.
  { href: '/timesheets', label: 'Timesheets', icon: 'clock', group: 'work', roles: ['master', 'technician', 'apprentice'] },
  /*
   * PAY-01…08, split on 30 October 2026 (the tester): EVERYBODY has their own
   * month — My Monthly Forms — and the office (Master, Coordinator) also has
   * EJE Monthly Forms: every user's status and the package to Finance.
   */
  { href: '/payroll/mine', label: 'My Monthly Forms', icon: 'document', group: 'work' },
  { href: '/payroll', label: 'EJE Monthly Forms', icon: 'document', capability: 'payroll.finance', group: 'work' },
  {
    href: '/customers',
    label: 'Customers',
    icon: 'customers',
    capability: 'customers.view',
    group: 'records',
  },
  { href: '/library', label: 'Technical Library', icon: 'library', capability: 'library.view', group: 'records' },
  /*
   * USERS — WHO IS AVAILABLE, AND THEIR LEAVE. The Coordinator's (the tester,
   * 30 October 2026), so she need not go through Administration for it. It
   * offers availability only (`availability.manage`): no account, role or
   * password change. A Master keeps doing those in Administration.
   */
  { href: '/users', label: 'Users', icon: 'user', capability: 'availability.manage', roles: ['coordinator'], group: 'records' },
  /**
   * The company-wide audit trail. Office only.
   *
   * The capability is what the READ enforces (`loadActivityFeed`); this keeps
   * the item off a technician's sidebar so they are not offered a screen that
   * would refuse them. The two are deliberately the same capability.
   */
  {
    href: '/activity',
    label: 'Activity',
    icon: 'activity',
    capability: 'activity.viewAll',
    group: 'system',
  },
  /** Chat. Separate from Notifications on purpose — see `types/message.ts`. */
  { href: '/messages', label: 'Messages', icon: 'note', group: 'system' },
  { href: '/notifications', label: 'Notifications', icon: 'bell', group: 'system' },
  { href: '/admin', label: 'Administration', icon: 'settings', capability: 'admin.access', group: 'system' },
];

export const NAV_GROUP_LABELS: Record<NavigationItem['group'], string> = {
  work: 'Work',
  records: 'Records',
  system: 'System',
};
