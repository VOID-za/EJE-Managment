'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Avatar, ConfirmDialog, Icon, Menu } from '@/components/ui';
import { useApp } from '@/providers/AppProvider';
import { usePendingWork } from '@/hooks/usePendingWork';
import { DemoUserSwitcher } from './DemoUserSwitcher';
import { ThemeToggleButton } from './ThemeToggle';
import { roleLabel, userFullName } from '@/domain';
import { cn } from '@/lib/cn';

export interface TopBarProps {
  readonly onOpenMenu: () => void;
  readonly unreadCount: number;
}

export const TopBar = ({ onOpenMenu, unreadCount }: TopBarProps) => {
  const router = useRouter();
  const { currentUser, signOut } = useApp();
  const [term, setTerm] = useState('');
  /*
   * SIGNING OUT WITH UNSENT WORK IS NOT SILENT. OFF-6, CR-02, BD-16.
   *
   * The captures stay on the tablet — `clearCachedJobs` deliberately does not
   * touch them — but a technician who signs out believing their hours went to
   * the server has been misled by omission. So the menu asks, names the
   * number, and says what happens to them: retained under their own name,
   * shown to nobody else, and sent when THEY sign in here again.
   *
   * Referred captures are not counted. The office has those (BD-15), so
   * "has not reached the EJE server" would be untrue of them — and a
   * technician who has already handed their problem over should not be warned
   * about it again every time they sign out.
   */
  const pending = usePendingWork();
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const unsent = pending.waiting.length + pending.conflicts.length;

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = term.trim();
    router.push(trimmed.length === 0 ? '/search' : `/search?q=${encodeURIComponent(trimmed)}`);
  };

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-steel-200 bg-surface/85 px-4 backdrop-blur-md lg:px-6">
      <button
        type="button"
        onClick={onOpenMenu}
        aria-label="Open navigation"
        className="-ml-2 rounded-[var(--radius-control)] p-2.5 text-steel-600 hover:bg-steel-100 lg:hidden"
      >
        <Icon name="menu" />
      </button>

      <form onSubmit={submitSearch} className="relative min-w-0 flex-1 md:max-w-xl">
        <Icon
          name="search"
          className="pointer-events-none absolute top-1/2 left-3 size-[18px] -translate-y-1/2 text-steel-400"
        />
        <input
          type="search"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder="Search jobs, customers, machines, serial numbers…"
          aria-label="Global search"
          className={cn(
            'h-11 w-full rounded-[var(--radius-control)] border border-steel-300 bg-steel-50 pr-3 pl-10 text-sm',
            'placeholder:text-steel-400 hover:border-steel-400',
            'focus:border-eje-500 focus:bg-surface focus:ring-2 focus:ring-eje-100 focus:outline-none',
          )}
        />
      </form>

      <div className="ml-auto flex items-center gap-1.5">
        {/* Demonstration deployments only. Renders nothing at all unless the
            server says the switcher exists — see DemoUserSwitcher. */}
        <span className="hidden sm:block">
          <DemoUserSwitcher variant="header" />
        </span>
        <ThemeToggleButton />

        <Link
          href="/notifications"
          aria-label={`Notifications${unreadCount > 0 ? `, ${unreadCount} unread` : ''}`}
          className="relative rounded-[var(--radius-control)] p-2.5 text-steel-600 transition-colors hover:bg-steel-100"
        >
          <Icon name="bell" />
          {unreadCount > 0 && (
            <span className="tabular absolute top-1 right-1 inline-flex min-w-4 items-center justify-center rounded-full bg-signal-500 px-1 text-[10px] font-bold text-white">
              {unreadCount}
            </span>
          )}
        </Link>

        {/* The only place the signed-in person and their actions live. The
            sidebar carries navigation and nothing else. */}
        {currentUser !== null && (
          <div className="ml-1 border-l border-steel-200 pl-1.5">
            <Menu
              trigger="plain"
              label={userFullName(currentUser)}
              sublabel={roleLabel(currentUser.role)}
              leading={<Avatar initials={currentUser.initials} size="sm" />}
              triggerClassName="gap-2.5"
              items={[
                {
                  id: 'profile',
                  label: 'My availability',
                  icon: <Icon name="calendar" className="size-4" />,
                  onSelect: () => router.push(`/technicians/${currentUser.id}`),
                },
                {
                  id: 'notifications',
                  label: 'Notifications',
                  icon: <Icon name="bell" className="size-4" />,
                  onSelect: () => router.push('/notifications'),
                },
                {
                  id: 'signout',
                  label: 'Sign out',
                  icon: <Icon name="logout" className="size-4" />,
                  destructive: true,
                  onSelect: () => {
                    if (unsent > 0) {
                      setConfirmSignOut(true);
                      return;
                    }
                    void signOut();
                  },
                },
              ]}
            />
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmSignOut}
        title="Sign out with work still unsent?"
        message={
          <>
            <p>
              {unsent} {unsent === 1 ? 'capture has' : 'captures have'} not reached the EJE server.
            </p>
            <p className="mt-2 text-steel-500">
              They stay on this tablet under your name and are sent the next time{' '}
              <strong>you</strong> sign in here with a connection. The next person to use this
              tablet will not see them and cannot send them.
            </p>
            <p className="mt-2 text-steel-500">
              Nothing is lost by signing out — but nothing is on the job yet either, so do not
              tell the office it is captured until it has gone.
            </p>
          </>
        }
        confirmLabel="Sign out"
        confirmVariant="danger"
        onConfirm={() => {
          setConfirmSignOut(false);
          void signOut();
        }}
        onCancel={() => setConfirmSignOut(false)}
      />
    </header>
  );
};
