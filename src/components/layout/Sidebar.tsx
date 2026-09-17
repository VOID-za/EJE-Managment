'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { can, userFullName } from '@/domain';
import { NAV_GROUP_LABELS, NAVIGATION, type NavigationItem } from '@/config/navigation';
import { Avatar, Icon, type IconName } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useApp } from '@/providers/AppProvider';
import { Logo } from './Logo';
import { DemoModeBadge } from './DemoModeBadge';
import { ThemeToggle } from './ThemeToggle';

const GROUP_ORDER: readonly NavigationItem['group'][] = ['work', 'records', 'system'];

export const Sidebar = ({
  onNavigate,
  unreadCount,
}: {
  readonly onNavigate?: () => void;
  readonly unreadCount: number;
}) => {
  const pathname = usePathname();
  const { currentUser, signOut } = useApp();

  const visible = NAVIGATION.filter(
    (item) =>
      item.capability === undefined ||
      (currentUser !== null && can(currentUser.role, item.capability)),
  );

  return (
    <div className="eje-grid-texture flex h-full flex-col bg-chrome">
      <div className="px-5 py-5">
        <Link href="/dashboard" onClick={onNavigate} className="block">
          <Logo />
        </Link>
      </div>

      <nav className="eje-scrollbar flex-1 overflow-y-auto px-3 pb-4">
        {GROUP_ORDER.map((group) => {
          const items = visible.filter((item) => item.group === group);
          if (items.length === 0) return null;

          return (
            <div key={group} className="mb-5">
              <p className="px-3 pb-2 text-[11px] font-semibold tracking-wider text-chrome-faint uppercase">
                {NAV_GROUP_LABELS[group]}
              </p>
              <ul className="space-y-0.5">
                {items.map((item) => {
                  const active =
                    pathname === item.href || pathname.startsWith(`${item.href}/`);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={onNavigate}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'flex min-h-11 items-center gap-3 rounded-[var(--radius-control)] px-3 text-sm font-medium transition-colors',
                          active
                            ? 'bg-action text-white shadow-sm'
                            : 'text-chrome-muted hover:bg-white/8 hover:text-white',
                        )}
                      >
                        <Icon name={item.icon as IconName} className="size-[18px]" />
                        <span className="flex-1 truncate">{item.label}</span>
                        {item.href === '/notifications' && unreadCount > 0 && (
                          <span className="tabular inline-flex min-w-5 items-center justify-center rounded-full bg-signal-500 px-1.5 py-0.5 text-[11px] font-bold text-white">
                            {unreadCount}
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>

      <div className="border-t border-white/10 p-3">
        <div className="mb-2 flex items-center justify-between gap-2 px-2">
          <DemoModeBadge compact />
          <ThemeToggle />
        </div>
        {currentUser !== null && (
          <div className="flex items-center gap-3 rounded-[var(--radius-control)] bg-white/5 p-2.5">
            <Avatar initials={currentUser.initials} size="md" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-white">
                {userFullName(currentUser)}
              </p>
              <p className="truncate text-xs text-chrome-dim">
                {currentUser.role === 'master' ? 'Master' : 'Technician'}
              </p>
            </div>
            <button
              type="button"
              onClick={signOut}
              title="Sign out"
              aria-label="Sign out"
              className="rounded-[var(--radius-control)] p-2 text-chrome-dim transition-colors hover:bg-white/10 hover:text-white"
            >
              <Icon name="logout" className="size-[18px]" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
