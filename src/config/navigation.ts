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
 */
export const NAVIGATION: readonly NavigationItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: 'dashboard', group: 'work' },
  { href: '/jobs', label: 'Jobs', icon: 'jobs', group: 'work' },
  { href: '/schedule', label: 'Schedule', icon: 'calendar', group: 'work' },
  {
    href: '/customers',
    label: 'Customers',
    icon: 'customers',
    capability: 'customers.view',
    group: 'records',
  },
  {
    href: '/machines',
    label: 'Machines',
    icon: 'machines',
    capability: 'customers.view',
    group: 'records',
  },
  { href: '/library', label: 'Technical Library', icon: 'library', capability: 'library.view', group: 'records' },
  { href: '/activity', label: 'Activity', icon: 'activity', group: 'system' },
  { href: '/notifications', label: 'Notifications', icon: 'bell', group: 'system' },
  { href: '/admin', label: 'Administration', icon: 'settings', capability: 'admin.access', group: 'system' },
];

export const NAV_GROUP_LABELS: Record<NavigationItem['group'], string> = {
  work: 'Work',
  records: 'Records',
  system: 'System',
};
