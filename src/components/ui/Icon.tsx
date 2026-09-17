import { cn } from '@/lib/cn';

/**
 * Inline icon set.
 *
 * A small hand-picked set keeps the demo free of an icon-library dependency and
 * guarantees a consistent 24px grid and stroke weight across the application.
 */
export type IconName =
  | 'dashboard'
  | 'jobs'
  | 'calendar'
  | 'customers'
  | 'machines'
  | 'library'
  | 'activity'
  | 'bell'
  | 'settings'
  | 'search'
  | 'plus'
  | 'check'
  | 'close'
  | 'chevronRight'
  | 'chevronDown'
  | 'arrowLeft'
  | 'clock'
  | 'truck'
  | 'wrench'
  | 'box'
  | 'camera'
  | 'note'
  | 'signature'
  | 'document'
  | 'star'
  | 'starFilled'
  | 'warning'
  | 'user'
  | 'logout'
  | 'menu'
  | 'trash'
  | 'download'
  | 'mail'
  | 'whatsapp'
  | 'pin'
  | 'refresh';

const PATHS: Record<IconName, string> = {
  dashboard: 'M4 13h6V4H4v9Zm0 7h6v-5H4v5Zm10 0h6v-9h-6v9Zm0-16v5h6V4h-6Z',
  jobs: 'M8 6V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v1M5 6h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Zm-2 5h18',
  calendar: 'M8 3v3m8-3v3M4 9h16M5 6h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z',
  customers:
    'M3 20v-1a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v1M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm8 9v-1a5 5 0 0 0-2.5-4.33M16 4.2a3.5 3.5 0 0 1 0 6.6',
  machines:
    'M4 20h16M6 20V9l6-4 6 4v11M10 20v-5h4v5M9.5 11.5h1m3 0h1',
  library: 'M5 4h5v16H5zM12 4h3v16h-3zM17.2 4.6l2.6.6-3.2 15-2.6-.6z',
  activity: 'M3 12h4l3 8 4-16 3 8h4',
  bell: 'M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6M13.7 20a2 2 0 0 1-3.4 0',
  settings:
    'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm8.4-2.1.1-1.4-.1-1.4 1.8-1.4-1.7-3-2.2.7a7.6 7.6 0 0 0-2.4-1.4L15.5 2h-3.5l-.4 2.5a7.6 7.6 0 0 0-2.4 1.4l-2.2-.7-1.7 3 1.8 1.4-.1 1.4.1 1.4-1.8 1.4 1.7 3 2.2-.7c.7.6 1.5 1.1 2.4 1.4l.4 2.5h3.5l.4-2.5c.9-.3 1.7-.8 2.4-1.4l2.2.7 1.7-3-1.8-1.4Z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5.2-1.8L21 21',
  plus: 'M12 5v14M5 12h14',
  check: 'M4.5 12.5 9.5 17.5 19.5 7',
  close: 'M6 6l12 12M18 6 6 18',
  chevronRight: 'M9 5l7 7-7 7',
  chevronDown: 'M5 9l7 7 7-7',
  arrowLeft: 'M19 12H5m0 0 6-6m-6 6 6 6',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-14v5l3.5 2',
  truck:
    'M3 16V6h11v10M14 9h3.5L21 12.5V16M3 16h1.5m5 0H14m0 0h2.5M6.5 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm11 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  wrench:
    'M15.6 3.8a5 5 0 0 0-6.2 6.4l-6 6a2 2 0 1 0 2.8 2.8l6-6a5 5 0 0 0 6.4-6.2l-3 3-2.2-2.2 3-3Z',
  box: 'M12 3 4 7v10l8 4 8-4V7l-8-4Zm0 0v18M4 7l8 4 8-4',
  camera:
    'M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Zm8 9a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z',
  note: 'M6 3h8l5 5v13H6zM14 3v5h5M9 13h7M9 17h5',
  signature:
    'M3 18c3 0 3-9 6-9s3 6 5 6 2.5-3 4-3 2 1.5 3 1.5M3 21h18',
  document: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h7M10 17h5',
  star: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9L12 3.5Z',
  starFilled: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9L12 3.5Z',
  warning: 'M12 9v5m0 3h.01M10.3 4.9 2.6 18.3a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.9a2 2 0 0 0-3.4 0Z',
  user: 'M4 20v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  logout: 'M15 17l5-5-5-5M20 12H9M12 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h6',
  menu: 'M4 7h16M4 12h16M4 17h16',
  trash: 'M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3',
  download: 'M12 3v12m0 0 4.5-4.5M12 15l-4.5-4.5M4 20h16',
  mail: 'M3 7h18v12H3zM3 7l9 7 9-7',
  whatsapp:
    'M20.5 11.7a8.4 8.4 0 0 1-12.4 7.4L3.5 20.5l1.4-4.5A8.4 8.4 0 1 1 20.5 11.7ZM9 8.6c.4-.1.7 0 .9.4l.7 1.5c.1.3.1.5-.1.8l-.4.5c-.2.2-.2.4 0 .7a7 7 0 0 0 2.6 2.3c.3.1.5.1.7-.1l.6-.7c.2-.2.4-.3.7-.2l1.6.7c.3.2.4.5.3.8-.2 1-1 1.7-2 1.8-2.9.2-6.8-3.6-6.9-6.5 0-1 .6-1.8 1.3-2Z',
  pin: 'M12 21s7-6 7-11a7 7 0 1 0-14 0c0 5 7 11 7 11Zm0-8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  refresh: 'M20 12a8 8 0 1 1-2.4-5.7M20 4v5h-5',
};

export interface IconProps {
  readonly name: IconName;
  readonly className?: string;
  readonly filled?: boolean;
}

export const Icon = ({ name, className, filled = false }: IconProps) => (
  <svg
    viewBox="0 0 24 24"
    className={cn('size-5 shrink-0', className)}
    fill={filled ? 'currentColor' : 'none'}
    stroke="currentColor"
    strokeWidth={1.7}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d={PATHS[name]} />
  </svg>
);
