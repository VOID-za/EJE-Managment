'use client';

import { useState } from 'react';
import { Badge, Button, Modal } from '@/components/ui';
import { DEMO_BUILD_LABEL, SIMULATED_CAPABILITIES } from '@/config/demo';
import { useApp } from '@/providers/AppProvider';

/**
 * Discreet, always-present indicator that this is the demonstration build, with
 * a full disclosure of exactly which capabilities are simulated and what each
 * will become in production.
 */
export const DemoModeBadge = ({ compact = false }: { readonly compact?: boolean }) => {
  const [open, setOpen] = useState(false);
  const { backend } = useApp();

  /*
   * The reset warning is shown ONLY on the in-memory backend.
   *
   * The badge itself is unconditional, so this sentence would otherwise appear
   * on a PostgreSQL deployment — where it is simply untrue, and where somebody
   * reading it would have every reason to distrust what the system tells them
   * next. `backend` comes from `/api/auth/me`, which is the server's answer
   * about itself; null means nobody has asked yet, and nothing is claimed.
   */
  const resets = backend === 'demo';

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full text-left transition-opacity hover:opacity-80"
        title="What is simulated in this demonstration?"
      >
        <Badge tone="amber" dot size={compact ? 'sm' : 'md'}>
          Demo Mode
        </Badge>
        {/*
          Beneath the pill rather than inside it.

          The badge is `whitespace-nowrap` by design, and a sentence this long
          in a 256px sidebar would run off the edge of it. Same information,
          same block, and the pill keeps the shape every other badge has.
        */}
        {resets && (
          <span
            className={
              compact
                ? 'mt-1.5 block text-[11px] leading-snug text-chrome-muted'
                : 'mt-1.5 block text-xs leading-snug text-steel-500'
            }
          >
            Data resets when the server restarts
          </span>
        )}
      </button>

      <Modal
        open={open}
        title="Demonstration Mode"
        description={DEMO_BUILD_LABEL}
        onClose={() => setOpen(false)}
        size="lg"
        footer={<Button onClick={() => setOpen(false)}>Close</Button>}
      >
        <p className="text-sm leading-relaxed text-steel-700">
          This build demonstrates the EJE Job Card Management System using fictional data. The
          workflow, business rules and job costing are real and run exactly as the production
          system will. The capabilities below are deliberately simulated — each one sits behind a
          service interface so it can be connected without changing any business logic.
        </p>

        <ul className="mt-5 space-y-3">
          {SIMULATED_CAPABILITIES.map((capability) => (
            <li
              key={capability.id}
              className="rounded-[var(--radius-control)] border border-steel-200 bg-steel-50 p-4"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-steel-900">{capability.name}</span>
                <Badge tone="amber" size="sm">
                  Simulated
                </Badge>
              </div>
              <p className="mt-1.5 text-sm text-steel-600">{capability.explanation}</p>
              <p className="mt-1.5 text-xs text-steel-500">
                <span className="font-semibold text-steel-600">In production: </span>
                {capability.productionPlan}
              </p>
            </li>
          ))}
        </ul>

        {/* The same fact the sidebar states, said once more where somebody has
            come looking for exactly this kind of detail. */}
        {resets && (
          <div className="mt-5 rounded-[var(--radius-control)] border border-amber-eje-200 bg-amber-eje-50 p-4">
            <p className="text-sm font-semibold text-amber-eje-700">
              Data resets when the server restarts
            </p>
            <p className="mt-1.5 text-sm text-steel-600">
              This demonstration keeps everything in the server’s memory, so jobs, attachments and
              sign-ins created here are gone when it restarts. It is what lets the demonstration
              run with nothing installed. A deployment with a database keeps all of it.
            </p>
          </div>
        )}

        <p className="mt-5 text-xs text-steel-500">
          No customer information in this demonstration is real. No email or WhatsApp message is
          ever transmitted.
        </p>
      </Modal>
    </>
  );
};
