'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { can } from '@/domain';
import { NAV_GROUP_LABELS, NAVIGATION, type NavigationItem } from '@/config/navigation';
import { Icon, type IconName } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useApp } from '@/providers/AppProvider';
import { Logo } from './Logo';
import { DemoModeBadge } from './DemoModeBadge';

const GROUP_ORDER: readonly NavigationItem['group'][] = ['work', 'records', 'system'];

export const Sidebar = ({
  onNavigate,
  unreadCount,
  unreadMessages,
}: {
  readonly onNavigate?: () => void;
  readonly unreadCount: number;
  readonly unreadMessages: number;
}) => {
  const pathname = usePathname();
  const { currentUser } = useApp();

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
                        {item.href === '/messages' && unreadMessages > 0 && (
                          <span className="tabular inline-flex min-w-5 items-center justify-center rounded-full bg-action px-1.5 py-0.5 text-[11px] font-bold text-white">
                            {unreadMessages}
                          </span>
                        )}
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

      {/* Navigation only. Who is signed in, signing out and the theme all
          live in the top bar, so there is one of each rather than two. */}
      <div className="border-t border-white/10 px-2 py-3">
        <DemoModeBadge compact />
      </div>
    </div>
  );
};
