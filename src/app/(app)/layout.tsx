'use client';

import { useState } from 'react';
import { Sidebar } from '@/components/layout/Sidebar';
import { TopBar } from '@/components/layout/TopBar';
import { SignInGate } from '@/components/layout/SignInGate';
import { useApp } from '@/providers/AppProvider';
import { useQuery } from '@/hooks/useQuery';
import { cn } from '@/lib/cn';

/**
 * Authenticated application shell: persistent sidebar on desktop, drawer on
 * tablet and phone, with a sticky top bar carrying global search.
 */
const AppLayout = ({ children }: { readonly children: React.ReactNode }) => {
  const { currentUser } = useApp();
  const [menuOpen, setMenuOpen] = useState(false);

  const notifications = useQuery(
    `notifications:${currentUser?.id ?? 'none'}`,
    async (repos) =>
      currentUser === null ? [] : repos.notifications.list(currentUser.id),
  );

  const unreadCount = (notifications.data ?? []).filter(
    (notification) => notification.readAt === null,
  ).length;

  // Messages carry their own badge. A chat waiting for a reply is a different
  // kind of claim on your attention from a system alert, so they are counted
  // and shown separately.
  const messages = useQuery(`messages:unread:${currentUser?.id ?? 'none'}`, async (repos) => {
    if (currentUser === null) return [];
    const all = await repos.chat.listMessagesFor(currentUser.id);
    return all.filter(
      (message) =>
        message.senderId !== currentUser.id && !message.readBy.includes(currentUser.id),
    );
  });
  const unreadMessages = (messages.data ?? []).length;

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
        <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-6 lg:px-8 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
};

export default AppLayout;
