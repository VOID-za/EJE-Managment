'use client';

import { useState } from 'react';
import { userFullName, type User } from '@/domain';
import { Avatar, Badge, Button, Icon } from '@/components/ui';
import { useApp } from '@/providers/AppProvider';
import { cn } from '@/lib/cn';
import { Logo } from './Logo';

/**
 * Demonstration sign-in.
 *
 * SIMULATED: there is no password check. A user is chosen so that both the
 * Master and Technician experiences can be shown side by side. Production
 * replaces this screen with real authentication; nothing downstream changes
 * because the rest of the application only ever reads `currentUser`.
 */
export const SignInGate = () => {
  const { users, signIn } = useApp();
  const [role, setRole] = useState<'master' | 'technician'>('master');

  const visible = users.filter((user) => user.role === role && user.active);

  return (
    <div className="flex min-h-dvh flex-col bg-steel-900 lg:flex-row">
      <div className="eje-grid-texture relative flex flex-col justify-between overflow-hidden p-8 lg:w-[46%] lg:p-12">
        <Logo />

        <div className="relative my-12 max-w-lg">
          <p className="text-xs font-semibold tracking-[0.2em] text-eje-300 uppercase">
            EJE Industrial Electronics
          </p>
          <h1 className="mt-4 text-4xl leading-tight font-bold text-white lg:text-5xl">
            Every job card, from the call-out to the customer signature.
          </h1>
          <p className="mt-5 text-base leading-relaxed text-steel-300">
            Breakdowns, installations, services and repairs — captured on site, costed
            automatically and signed off by the customer before the technician leaves.
          </p>

          <ul className="mt-8 space-y-3">
            {[
              'Guided job workflow built for rugged field tablets',
              'Mandatory checklists for installation and service work',
              'Customer signature and job card issued on the spot',
              'Full audit trail against every job, machine and customer',
            ].map((line) => (
              <li key={line} className="flex items-start gap-3 text-sm text-steel-300">
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-eje-500/20 text-eje-300">
                  <Icon name="check" className="size-3.5" />
                </span>
                {line}
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-xs text-steel-500">
          Demonstration build · fictional data only · no messages are transmitted
        </p>
      </div>

      <div className="flex flex-1 items-center justify-center bg-steel-50 p-6 lg:p-12">
        <div className="w-full max-w-md">
          <div className="mb-6">
            <div className="mb-3">
              <Badge tone="amber" dot>
                Demo Mode — choose a user to continue
              </Badge>
            </div>
            <h2 className="text-2xl font-bold text-steel-900">Sign in</h2>
            <p className="mt-1.5 text-sm text-steel-500">
              This demonstration has no password check. Select a user to see the system exactly as
              that role sees it.
            </p>
          </div>

          <div
            role="tablist"
            className="mb-4 grid grid-cols-2 gap-1 rounded-[var(--radius-control)] bg-steel-200/70 p-1"
          >
            {(['master', 'technician'] as const).map((option) => (
              <button
                key={option}
                type="button"
                role="tab"
                aria-selected={role === option}
                onClick={() => setRole(option)}
                className={cn(
                  'min-h-10 rounded-[0.45rem] text-sm font-semibold transition-colors',
                  role === option
                    ? 'bg-white text-steel-900 shadow-sm'
                    : 'text-steel-600 hover:text-steel-800',
                )}
              >
                {option === 'master' ? 'Master' : 'Technician'}
              </button>
            ))}
          </div>

          <p className="mb-3 text-xs text-steel-500">
            {role === 'master'
              ? 'Masters manage customers, machines, job allocation and system configuration. The office administrator uses this role.'
              : 'Technicians accept jobs, capture work on site and obtain the customer signature.'}
          </p>

          <ul className="eje-scrollbar max-h-[46vh] space-y-2 overflow-y-auto pr-1">
            {visible.map((user) => (
              <li key={user.id}>
                <UserButton user={user} onSelect={() => signIn(user.id)} />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
};

const UserButton = ({
  user,
  onSelect,
}: {
  readonly user: User;
  readonly onSelect: () => void;
}) => (
  <Button
    variant="secondary"
    fullWidth
    size="lg"
    onClick={onSelect}
    className="justify-start gap-3 px-3 text-left"
  >
    <Avatar initials={user.initials} size="md" />
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm font-semibold text-steel-900">
        {userFullName(user)}
      </span>
      <span className="block truncate text-xs font-normal text-steel-500">{user.jobTitle}</span>
    </span>
    <Icon name="chevronRight" className="size-4 text-steel-400" />
  </Button>
);
