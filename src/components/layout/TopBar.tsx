'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Avatar, Button, Icon } from '@/components/ui';
import { useApp } from '@/providers/AppProvider';
import { ThemeToggleButton } from './ThemeToggle';
import { userFullName } from '@/domain';
import { cn } from '@/lib/cn';

export interface TopBarProps {
  readonly onOpenMenu: () => void;
  readonly unreadCount: number;
}

export const TopBar = ({ onOpenMenu, unreadCount }: TopBarProps) => {
  const router = useRouter();
  const { currentUser } = useApp();
  const [term, setTerm] = useState('');

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

        <Link href="/jobs/new" className="hidden sm:block">
          <Button size="sm" leadingIcon={<Icon name="plus" className="size-4" />}>
            New Job
          </Button>
        </Link>

        {currentUser !== null && (
          <div className="ml-1 hidden items-center gap-2.5 border-l border-steel-200 pl-3 lg:flex">
            <Avatar initials={currentUser.initials} size="sm" />
            <div className="leading-tight">
              <p className="text-xs font-semibold text-steel-800">{userFullName(currentUser)}</p>
              <p className="text-[11px] text-steel-500">{currentUser.jobTitle}</p>
            </div>
          </div>
        )}
      </div>
    </header>
  );
};
