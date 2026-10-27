'use client';

import { useEffect, useState } from 'react';
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

  /*
   * NOTIF-AUDIT-1: THE BADGES RE-COUNT BY THEMSELVES. They used to re-count
   * only after a write made on this tablet, so a job assigned from the office
   * never showed on the bell until the technician did something. Every 30
   * seconds while the tab is visible, and the moment it is looked at again.
   */
  const refetchBadges = badges.refetch;
  useEffect(() => {
    if (currentUser === null) return;
    const recount = () => {
      if (document.visibilityState === 'visible') refetchBadges();
    };
    const timer = window.setInterval(recount, 30_000);
    document.addEventListener('visibilitychange', recount);
    window.addEventListener('focus', recount);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', recount);
      window.removeEventListener('focus', recount);
    };
  }, [currentUser, refetchBadges]);

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

      {/*
        THE CLOSED DRAWER IS INERT, NOT MERELY INVISIBLE.
        
        It is always in the DOM and slid off-canvas, which is what makes the
        animation possible — and it left twelve navigation links focusable and
        announced while they were off the screen. A technician working the
        tablet from a keyboard tabbed off the top bar into a menu they could not
        see, and a screen reader read the whole navigation twice. Found by
        `npm run responsive-check`.

        `inert` is the one attribute that fixes both: the subtree stops being
        focusable, stops taking pointer events and is removed from the
        accessibility tree. `pointer-events-none` only ever fixed the third of
        those, and `aria-hidden` on its own would hide links a keyboard could
        still reach — which is worse than either.
      */}
      <div
        aria-hidden={!menuOpen}
        inert={!menuOpen}
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
