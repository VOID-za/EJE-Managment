'use client';

import { useState } from 'react';
import { Sidebar } from '@/components/layout/Sidebar';
import { TopBar } from '@/components/layout/TopBar';
import { SignInGate } from '@/components/layout/SignInGate';
import { ConnectionBanner } from '@/components/layout/ConnectionBanner';
import { useApp } from '@/providers/AppProvider';
import { reads } from '@/api/endpoints';
import { useQuery } from '@/hooks/useQuery';
import { cn } from '@/lib/cn';

/**
 * Authenticated application shell: persistent sidebar on desktop, drawer on
 * tablet and phone, with a sticky top bar carrying global search.
 */
const AppLayout = ({ children }: { readonly children: React.ReactNode }) => {
  const { currentUser, ready } = useApp();
  const [menuOpen, setMenuOpen] = useState(false);

  /*
   * The two badges the shell carries, counted on the server.
   *
   * Messages have their own badge: a chat waiting for a reply is a different
   * kind of claim on your attention from a system alert, so they are counted
   * and shown separately.
   */
  const badges = useQuery(`shell:${currentUser?.id ?? 'none'}`, () =>
    currentUser === null
      ? Promise.resolve({ unreadNotifications: 0, unreadMessages: 0 })
      : reads.shell(),
  );

  const unreadCount = badges.data?.unreadNotifications ?? 0;
  const unreadMessages = badges.data?.unreadMessages ?? 0;

  // Nothing has been asked of the server yet, so there is no answer to draw on.
  if (!ready) return null;
  if (currentUser === null) return <SignInGate />;

  return (
    <div className="flex min-h-dvh bg-steel-100">
      <aside className="hidden w-64 shrink-0 lg:block print:hidden">
        <div className="fixed inset-y-0 left-0 w-64">
          <Sidebar unreadCount={unreadCount} unreadMessages={unreadMessages} />
        </div>
      </aside>

      <div
        className={cn(
          'fixed inset-0 z-50 lg:hidden',
          menuOpen ? 'pointer-events-auto' : 'pointer-events-none',
        )}
      >
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setMenuOpen(false)}
          className={cn(
            'absolute inset-0 bg-steel-950/50 transition-opacity',
            menuOpen ? 'opacity-100' : 'opacity-0',
          )}
        />
        <div
          className={cn(
            'absolute inset-y-0 left-0 w-72 max-w-[85vw] transition-transform duration-200',
            menuOpen ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          <Sidebar
            unreadCount={unreadCount}
            unreadMessages={unreadMessages}
            onNavigate={() => setMenuOpen(false)}
          />
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="print:hidden">
          <TopBar onOpenMenu={() => setMenuOpen(true)} unreadCount={unreadCount} />
        </div>
        {/* Above everything, because it is about whether anything below it is
            actually being kept. */}
        <ConnectionBanner />
        <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-6 lg:px-8 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
};

export default AppLayout;
