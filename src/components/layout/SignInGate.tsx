'use client';

import { useState, type FormEvent } from 'react';
import { Badge, Button, Icon, TextField } from '@/components/ui';
import { useApp } from '@/providers/AppProvider';
import { DEMO_PASSWORD_HINT } from '@/lib/demo-credentials';
import { Logo } from './Logo';
import { ThemeToggle } from './ThemeToggle';

/**
 * Signing in.
 *
 * WHAT THIS USED TO BE: a list of people. You picked one and the browser
 * decided it was you — which meant every rule downstream was being enforced
 * against an identity the client had chosen for itself.
 *
 * WHAT IT IS NOW: an email address and a password, verified on the server
 * against an Argon2id hash. What comes back is a session cookie the browser
 * cannot read, and an identity the browser did not choose. There is no role
 * selector, because a role is not something anybody selects.
 *
 * ONE MESSAGE FOR EVERY FAILURE, from the server. Wrong password, unknown
 * address, disabled account, locked account — the same sentence, so the screen
 * cannot be used to ask which of EJE's addresses are real.
 */
export const SignInGate = () => {
  const { signIn, backend } = useApp();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await signIn(email.trim(), password);
    setBusy(false);
    if (!result.ok) {
      setError(result.message ?? 'That email address and password do not match.');
      // The address is kept — a mistyped password should not cost you both.
      setPassword('');
    }
  };

  return (
    <div className="flex min-h-dvh flex-col bg-chrome lg:flex-row">
      <div className="eje-grid-texture relative flex flex-col justify-between overflow-hidden p-8 lg:w-[46%] lg:p-12">
        <Logo />

        <div className="relative my-12 max-w-lg">
          <p className="text-xs font-semibold tracking-[0.2em] text-eje-300 uppercase">
            EJE Industrial Electronics
          </p>
          <h1 className="mt-4 text-4xl leading-tight font-bold text-white lg:text-5xl">
            Every job card, from the call-out to the customer signature.
          </h1>
          <p className="mt-5 text-base leading-relaxed text-chrome-muted">
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
              <li key={line} className="flex items-start gap-3 text-sm text-chrome-muted">
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-eje-500/20 text-eje-300">
                  <Icon name="check" className="size-3.5" />
                </span>
                {line}
              </li>
            ))}
          </ul>
        </div>

        <div className="relative mb-6">
          <ThemeToggle />
        </div>

        <p className="relative text-xs text-chrome-faint">
          {backend === 'demo'
            ? 'Demonstration build · fictional data only · no messages are transmitted'
            : 'EJE Industrial Electronics · job card management'}
        </p>
      </div>

      <div className="flex flex-1 items-center justify-center bg-steel-50 p-6 lg:p-12">
        <div className="w-full max-w-md">
          <div className="mb-6">
            {backend === 'demo' && (
              <div className="mb-3">
                <Badge tone="amber" dot>
                  Demonstration data — not the live register
                </Badge>
              </div>
            )}
            <h2 className="text-2xl font-bold text-steel-900">Sign in</h2>
            <p className="mt-1.5 text-sm text-steel-500">
              Use the email address EJE issued you. Your role comes from your account.
            </p>
          </div>

          <form onSubmit={submit} className="space-y-4" noValidate>
            <TextField
              label="Email address"
              type="email"
              name="email"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
            <TextField
              label="Password"
              type="password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />

            {error !== null && (
              <p
                role="alert"
                className="rounded-[var(--radius-control)] bg-danger-50 px-3 py-2.5 text-sm font-medium text-danger-700"
              >
                {error}
              </p>
            )}

            <Button type="submit" fullWidth size="lg" loading={busy}>
              Sign in
            </Button>
          </form>

          {backend === 'demo' && (
            <p className="mt-5 rounded-[var(--radius-control)] bg-steel-100 px-3 py-2.5 text-xs leading-relaxed text-steel-600">
              {DEMO_PASSWORD_HINT}
            </p>
          )}
        </div>
      </div>
    </div>
  );
};
