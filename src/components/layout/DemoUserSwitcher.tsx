'use client';

import { useEffect, useState } from 'react';
import { roleLabel } from '@/domain';
import { Avatar, Badge, Button, Icon, Modal } from '@/components/ui';
import { demoUsers, type DemoAccount } from '@/api/endpoints';
import { useApp } from '@/providers/AppProvider';

/**
 * Switching between the seeded development accounts, in one click.
 *
 * DEVELOPMENT ONLY, and it says so on every surface it draws. The list comes
 * from `GET /api/dev/demo-users`, which answers 404 in production — so this
 * component renders NOTHING there. There is no flag to get wrong on the client:
 * if the server has no switcher, the browser never learns of one.
 *
 * WHAT HAPPENS ON A CLICK: the server performs the real sign-in — it verifies
 * the published development password against the account's stored Argon2id hash
 * and issues an ordinary session cookie. The browser then asks who it is, the
 * same as on any other visit. Nothing here decides a role, and nothing here
 * holds a credential: this is the login form with the typing removed.
 */
export const DemoUserSwitcher = ({ variant }: { readonly variant: 'header' | 'gate' }) => {
  const { currentUser, adoptSession } = useApp();
  const [accounts, setAccounts] = useState<readonly DemoAccount[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /*
   * Asked once. A 404 is the ordinary answer in production and is not an error
   * to report — it is how the server says this feature does not exist.
   */
  useEffect(() => {
    let cancelled = false;
    demoUsers
      .list()
      .then((result) => {
        if (!cancelled) setAccounts(result.users);
      })
      .catch(() => {
        if (!cancelled) setAccounts([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (accounts === null || accounts.length === 0) return null;

  const choose = async (account: DemoAccount): Promise<void> => {
    setBusy(account.email);
    setError(null);
    try {
      await demoUsers.switchTo(account.email);
      // The server decided who we are; ask it, rather than assuming.
      await adoptSession();
      setOpen(false);
    } catch {
      setError(
        `${account.email} is not in this database. Run "npm run db:seed" against it, or set ` +
          'DATABASE_URL to a seeded development database and restart.',
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Switch between the seeded development accounts"
        className={
          variant === 'header'
            ? 'flex items-center gap-2 rounded-[var(--radius-control)] border border-dashed border-amber-400 bg-amber-50 px-2.5 py-1.5 text-xs font-semibold text-amber-800 transition-colors hover:bg-amber-100'
            : 'flex w-full items-center justify-center gap-2 rounded-[var(--radius-control)] border border-dashed border-amber-400 bg-amber-50 px-3 py-2.5 text-sm font-semibold text-amber-800 transition-colors hover:bg-amber-100'
        }
      >
        <Icon name="user" className="size-4" />
        {/* Deliberately never the words "sign in": the real submit button says
            that, and a duplicate would make every script that clicks it
            ambiguous — including the suites that drive this application. */}
        <span>DEMO ONLY · Switch user</span>
      </button>

      <Modal
        open={open}
        title="Switch demo user — DEVELOPMENT ONLY"
        description="Signs in as one of the seeded demonstration accounts, with no password entry."
        onClose={() => setOpen(false)}
        size="md"
        footer={
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Close
          </Button>
        }
      >
        <div className="mb-4 rounded-[var(--radius-control)] border border-dashed border-amber-400 bg-amber-50 p-3">
          <div className="flex items-center gap-2">
            <Badge tone="amber" dot size="sm">
              DEMO ONLY
            </Badge>
            <span className="text-xs font-semibold text-amber-800">
              This control does not exist in production.
            </span>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-steel-600">
            Each of these is a real sign-in: the server verifies the published development
            password and issues an ordinary session, so every permission and visibility rule
            applies exactly as it does when you log in by hand.
          </p>
        </div>

        {error !== null && (
          <p
            role="alert"
            className="mb-3 rounded-[var(--radius-control)] bg-danger-50 px-3 py-2.5 text-sm font-medium text-danger-700"
          >
            {error}
          </p>
        )}

        <ul className="space-y-2">
          {accounts.map((account) => {
            const active = currentUser?.email.toLowerCase() === account.email;
            return (
              <li key={account.email}>
                <button
                  type="button"
                  onClick={() => void choose(account)}
                  disabled={busy !== null}
                  className={[
                    'flex w-full items-center gap-3 rounded-[var(--radius-control)] border px-3 py-3 text-left transition-colors',
                    active
                      ? 'border-eje-400 bg-eje-50'
                      : 'border-steel-200 hover:border-steel-400 hover:bg-steel-50',
                    busy !== null ? 'cursor-not-allowed opacity-60' : '',
                  ].join(' ')}
                >
                  <Avatar
                    initials={`${account.firstName[0] ?? ''}${account.lastName[0] ?? ''}`}
                    size="sm"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-steel-900">
                      {account.firstName} {account.lastName}
                    </span>
                    <span className="block truncate text-xs text-steel-500">{account.email}</span>
                  </span>
                  <Badge tone={active ? 'blue' : 'neutral'} size="sm">
                    {roleLabel(account.role)}
                  </Badge>
                  {busy === account.email && (
                    <Icon name="refresh" className="size-4 animate-spin text-steel-500" />
                  )}
                  {active && busy === null && (
                    <Icon name="check" className="size-4 text-eje-600" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </Modal>
    </>
  );
};
