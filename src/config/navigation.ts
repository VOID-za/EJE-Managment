import type { Capability } from '@/domain';

export interface NavigationItem {
  readonly href: string;
  readonly label: string;
  readonly icon: string;
  readonly capability?: Capability;
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
  { href: '/dashboard', label: 'Dashboard', icon: 'dashboard', group: 'work' },
  { href: '/jobs', label: 'Jobs', icon: 'jobs', group: 'work' },
  /**
   * Scheduled work and technician availability. Office only.
   *
   * The capability is the one the READ enforces (`calendarView`), for the same
   * reason Activity's is: offering a technician a screen that then refuses them
   * is how "Something went wrong" ends up on a sidebar item they were invited
   * to click. The two are deliberately the same capability.
   */
  {
    href: '/calendar',
    label: 'Calendar',
    icon: 'calendar',
    capability: 'availability.manage',
    group: 'work',
  },
  /**
   * The job card archive. A Master's obvious answer to "where do I find a
   * closed job?", which a status filter buried inside Jobs was not.
   *
   * Master-only: a technician still reaches historical jobs through the
   * customer, site and machine history they already have access to.
   */
  {
    href: '/jobs/closed',
    label: 'Closed Jobs',
    icon: 'document',
    capability: 'jobs.viewAll',
    group: 'work',
  },
  {
    href: '/customers',
    label: 'Customers',
    icon: 'customers',
    capability: 'customers.view',
    group: 'records',
  },
  { href: '/library', label: 'Technical Library', icon: 'library', capability: 'library.view', group: 'records' },
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
