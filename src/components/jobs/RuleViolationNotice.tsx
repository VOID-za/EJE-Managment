import type { RuleViolation } from '@/domain';
import { Icon } from '@/components/ui';

/**
 * Explains exactly why a workflow step is blocked. The list comes straight from
 * the domain rules, so the technician is told what is outstanding rather than
 * being shown a disabled button with no explanation.
 */
export const RuleViolationNotice = ({
  title,
  violations,
  message,
}: {
  readonly title: string;
  readonly violations: readonly RuleViolation[];
  readonly message?: string | null;
}) => {
  if (violations.length === 0 && (message === null || message === undefined)) return null;

  return (
    <div
      role="alert"
      className="rounded-[var(--radius-control)] border border-amber-eje-200 bg-amber-eje-50 p-4"
    >
      <p className="flex items-center gap-2 text-sm font-semibold text-amber-eje-700">
        <Icon name="warning" className="size-4" />
        {title}
      </p>
      {message !== null && message !== undefined && message.length > 0 && (
        <p className="mt-1.5 text-sm text-amber-eje-700">{message}</p>
      )}
      {violations.length > 0 && (
        <ul className="mt-2 space-y-1">
          {/*
            Keyed by position, not by code.

            A rule check legitimately returns several violations that share a
            code — the wizard groups its outstanding items under one — and
            keying by code made React see duplicates, warn, and reconcile the
            list wrongly. Position is the honest key here: this is an ordered
            list of messages that is replaced wholesale, never reordered.
          */}
          {violations.map((violation, index) => (
            <li
              key={`${violation.code}-${index}`}
              className="flex items-start gap-2 text-sm text-steel-700"
            >
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-amber-eje-500" />
              {violation.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
