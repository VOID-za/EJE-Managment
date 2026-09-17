'use client';

import { useState } from 'react';
import { Badge, Button, Modal } from '@/components/ui';
import { DEMO_BUILD_LABEL, SIMULATED_CAPABILITIES } from '@/config/demo';

/**
 * Discreet, always-present indicator that this is the demonstration build, with
 * a full disclosure of exactly which capabilities are simulated and what each
 * will become in production.
 */
export const DemoModeBadge = ({ compact = false }: { readonly compact?: boolean }) => {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full transition-opacity hover:opacity-80"
        title="What is simulated in this demonstration?"
      >
        <Badge tone="amber" dot size={compact ? 'sm' : 'md'}>
          Demo Mode
        </Badge>
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

        <p className="mt-5 text-xs text-steel-500">
          No customer information in this demonstration is real. No email or WhatsApp message is
          ever transmitted.
        </p>
      </Modal>
    </>
  );
};
